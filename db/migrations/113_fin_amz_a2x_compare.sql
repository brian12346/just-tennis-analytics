-- Finance › Amazon payouts › A2X vs Seller Sage (Brian, Oct 10): A2X's journal entries for each settlement (read from
-- QuickBooks by amzpay: check / a2x_lines) are kept here line by line, so the page can compare them with the entries
-- Seller Sage builds for the same settlement (fin.amz_entry), by account and by line.

create table if not exists fin.amz_a2x_lines (
  doc           text not null,                      -- A2X's journal entry number
  line_no       integer not null,
  settlement_id text not null,
  je_id         text not null default '',
  txn_date      date,
  currency      text not null default 'USD',
  fx            numeric,
  kind          text not null default 'main',       -- main | cogs (A2X's …C nnn entries)
  account       text not null default '',
  description   text not null default '',
  amount        numeric(14,2) not null default 0,   -- + debit, − credit
  synced_at     timestamptz not null default now(),
  primary key (doc, line_no)
);
create index if not exists amz_a2x_lines_settlement on fin.amz_a2x_lines (settlement_id);

-- p = {settlement_id, entries: [{doc, id, date, currency, fx, lines: [{account, description, amount}]}]}; a settlement's
-- lines are replaced as a whole (lines no longer there are zeroed)
create or replace function public.fin_amz_a2x_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare sid text := p->>'settlement_id'; n int;
begin
  if coalesce(sid, '') = '' then raise exception 'settlement_id missing'; end if;
  update fin.amz_a2x_lines set amount = 0, synced_at = now() where settlement_id = sid;
  insert into fin.amz_a2x_lines (doc, line_no, settlement_id, je_id, txn_date, currency, fx, kind, account, description, amount, synced_at)
  select e->>'doc', l.n::int, sid, coalesce(e->>'id', ''), (e->>'date')::date, coalesce(e->>'currency', 'USD'), (e->>'fx')::numeric,
         case when e->>'doc' ~ 'C\d{3}$' then 'cogs' else 'main' end,
         coalesce(l.v->>'account', ''), coalesce(l.v->>'description', ''), coalesce((l.v->>'amount')::numeric, 0), now()
  from jsonb_array_elements(coalesce(p->'entries', '[]'::jsonb)) e
  cross join lateral jsonb_array_elements(coalesce(e->'lines', '[]'::jsonb)) with ordinality l(v, n)
  on conflict (doc, line_no) do update set settlement_id = excluded.settlement_id, je_id = excluded.je_id, txn_date = excluded.txn_date,
    currency = excluded.currency, fx = excluded.fx, kind = excluded.kind, account = excluded.account, description = excluded.description,
    amount = excluded.amount, synced_at = now();
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.fin_amz_a2x_save(jsonb) from public;

-- settlements A2X posted whose lines aren't read yet
create or replace function public.fin_amz_a2x_todo() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(s.settlement_id order by s.start_at), '{}') from fin.amz_settlements s
  where cardinality(s.a2x_docs) > 0 and not exists (select 1 from fin.amz_a2x_lines l where l.settlement_id = s.settlement_id and l.amount <> 0)
$$;
revoke all on function public.fin_amz_a2x_todo() from public;

-- Seller Sage's lines for every settlement A2X posted (from fin.amz_entry), one row per line
create or replace view fin.v_amz_ours_lines as
select s.settlement_id, p->>'doc' as doc, p->>'kind' as kind, (p->>'date')::date as txn_date, p->>'currency' as currency,
       l->>'account' as account, l->>'description' as description, round((l->>'amount')::numeric, 2) as amount
from fin.amz_settlements s
cross join lateral jsonb_array_elements(fin.amz_entry(s.settlement_id)->'parts') p
cross join lateral jsonb_array_elements(p->'lines') l
where cardinality(s.a2x_docs) > 0;

-- by settlement and account: A2X vs Seller Sage (settlement currency for payout lines; cost of goods in USD)
create or replace view fin.v_amz_compare as
with ours as (select settlement_id, kind, account, sum(amount) as amount, count(*) as lines from fin.v_amz_ours_lines group by 1, 2, 3),
a2x as (select settlement_id, kind, account, sum(amount) as amount, count(*) filter (where amount <> 0) as lines from fin.amz_a2x_lines group by 1, 2, 3)
select coalesce(o.settlement_id, a.settlement_id) as settlement_id, coalesce(o.kind, a.kind) as kind, coalesce(o.account, a.account) as account,
       coalesce(a.amount, 0) as a2x, coalesce(o.amount, 0) as ours, coalesce(o.amount, 0) - coalesce(a.amount, 0) as diff,
       coalesce(a.lines, 0) as a2x_lines, coalesce(o.lines, 0) as our_lines
from ours o full join a2x a on a.settlement_id = o.settlement_id and a.kind = o.kind and a.account = o.account
where coalesce(o.settlement_id, a.settlement_id) in (select settlement_id from fin.amz_a2x_lines where amount <> 0);

grant select on fin.amz_a2x_lines, fin.v_amz_ours_lines, fin.v_amz_compare to fin_reader;
grant execute on function fin.amz_entry(text) to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_amz_a2x_save(jsonb), public.fin_amz_a2x_todo() from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_amz_a2x_save(jsonb), public.fin_amz_a2x_todo() to service_role;
  end if;
end $$;
