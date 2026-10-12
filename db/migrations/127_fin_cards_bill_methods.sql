-- Finance › credit cards and how bills will be paid
--  · fin.card_terms: each card's statement close day and payment due day (day of the month; 31 = the month's last day)
--  · fin.bill_pay_method: the bank account or card an open bill will be paid from (picked on Payables; blank until set)
--  · fin.card_pay_date(close, due, d): the day a charge made on d is paid — the due day after the statement it lands on
--    (a charge on the close day is on that statement)
--  · fin.v_cards: each card's balance, what's owed, its next close and when the current balance is due
--  · fin.v_bill_plan: each open bill's method, the day it's charged / paid (its due date, or today if overdue) and the
--    day the cash goes out (the card's payment date for a card with terms; otherwise the pay day)
create table if not exists fin.card_terms (
  account_id text primary key,
  close_day int not null check (close_day between 1 and 31),
  due_day int not null check (due_day between 1 and 31),
  updated_by text not null default '',
  updated_at timestamptz not null default now()
);

create table if not exists fin.bill_pay_method (
  bill_id text primary key,
  account_id text not null,
  set_by text not null default '',
  set_at timestamptz not null default now()
);

-- day dd of m's month, or the month's last day when it's shorter
create or replace function fin.month_day(m date, dd int) returns date
language sql immutable set search_path = '' as $$
  select date_trunc('month', m)::date + (least(dd, extract(day from date_trunc('month', m) + interval '1 month - 1 day')::int) - 1)
$$;

create or replace function fin.card_pay_date(close_day int, due_day int, d date) returns date
language sql immutable set search_path = '' as $$
  with c as (
    select case when d <= fin.month_day(d, close_day) then fin.month_day(d, close_day)
                else fin.month_day((date_trunc('month', d) + interval '1 month')::date, close_day) end as close)
  select case when fin.month_day(close, due_day) > close then fin.month_day(close, due_day)
              else fin.month_day((date_trunc('month', close) + interval '1 month')::date, due_day) end
  from c
$$;

create or replace view fin.v_cards as
with t as (select (now() at time zone 'America/Los_Angeles')::date as today),
a as (
  select a.id as account_id, a.name, a.balance, a.qbo_updated, t.close_day, t.due_day, t.updated_by, t.updated_at, x.today,
         -- QuickBooks keeps what's owed on a card as a negative balance
         greatest(-a.balance, 0) as owed,
         case when t.close_day is null then null
              when x.today >= fin.month_day(x.today, t.close_day) then fin.month_day(x.today, t.close_day)
              else fin.month_day((date_trunc('month', x.today) - interval '1 month')::date, t.close_day) end as last_close
  from fin.qbo_accounts a cross join t x left join fin.card_terms t on t.account_id = a.id
  where a.active and a.type = 'Credit Card')
select a.account_id, a.name, a.balance, a.owed, a.qbo_updated, a.close_day, a.due_day, a.updated_by, a.updated_at, a.last_close,
       case when a.close_day is null then null else fin.card_pay_date(a.close_day, a.due_day, a.today) end as next_due,
       case when a.close_day is null then null
            when a.today < fin.month_day(a.today, a.close_day) then fin.month_day(a.today, a.close_day)
            else fin.month_day((date_trunc('month', a.today) + interval '1 month')::date, a.close_day) end as next_close,
       -- the balance is paid on the last statement's due date if that's still ahead, else on the next one (charges since
       -- the close are on the balance too; they're counted with the earlier payment, the cautious side)
       case when a.close_day is null then null
            when fin.card_pay_date(a.close_day, a.due_day, a.last_close) >= a.today then fin.card_pay_date(a.close_day, a.due_day, a.last_close)
            else fin.card_pay_date(a.close_day, a.due_day, a.today) end as balance_due_on
from a;

create or replace view fin.v_bill_plan as
with t as (select (now() at time zone 'America/Los_Angeles')::date as today)
select b.id as bill_id, m.account_id, a.name as account_name, a.type as account_type, m.set_by, m.set_at,
       greatest(coalesce(b.due_date, x.today), x.today) as pay_on,
       case when a.type = 'Credit Card' and ct.close_day is not null
            then fin.card_pay_date(ct.close_day, ct.due_day, greatest(coalesce(b.due_date, x.today), x.today))
            else greatest(coalesce(b.due_date, x.today), x.today) end as cash_on,
       (a.type = 'Credit Card' and ct.close_day is null) as card_needs_terms
from fin.qbo_bills b cross join t x
left join fin.bill_pay_method m on m.bill_id = b.id
left join fin.qbo_accounts a on a.id = m.account_id
left join fin.card_terms ct on ct.account_id = m.account_id
where b.balance <> 0;

-- p: {bill_ids: [...], account_id} (account_id '' or null clears the method)
create or replace function public.fin_bill_method_set(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '');
        acct text := nullif(p->>'account_id', ''); n int;
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if acct is null then
    delete from fin.bill_pay_method where bill_id in (select jsonb_array_elements_text(p->'bill_ids'));
    get diagnostics n = row_count; return n;
  end if;
  if not exists (select 1 from fin.qbo_accounts where id = acct and type in ('Bank', 'Credit Card')) then
    raise exception 'not a bank account or card' using errcode = '22023';
  end if;
  insert into fin.bill_pay_method (bill_id, account_id, set_by)
  select b, acct, who from jsonb_array_elements_text(p->'bill_ids') b
  on conflict (bill_id) do update set account_id = excluded.account_id, set_by = excluded.set_by, set_at = now();
  get diagnostics n = row_count; return n;
end $$;

-- p: {account_id, close_day, due_day} (close_day null removes the card's terms)
create or replace function public.fin_card_terms_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '');
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if nullif(p->>'close_day', '') is null then
    delete from fin.card_terms where account_id = p->>'account_id'; return found;
  end if;
  if not exists (select 1 from fin.qbo_accounts where id = p->>'account_id' and type = 'Credit Card') then
    raise exception 'not a card' using errcode = '22023';
  end if;
  insert into fin.card_terms (account_id, close_day, due_day, updated_by)
  values (p->>'account_id', (p->>'close_day')::int, (p->>'due_day')::int, who)
  on conflict (account_id) do update set close_day = excluded.close_day, due_day = excluded.due_day, updated_by = excluded.updated_by, updated_at = now();
  return true;
end $$;

grant select on fin.card_terms, fin.bill_pay_method, fin.v_cards, fin.v_bill_plan to fin_reader;
grant execute on function fin.month_day(date, int), fin.card_pay_date(int, int, date) to fin_reader;
revoke all on function public.fin_bill_method_set(jsonb), public.fin_card_terms_set(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_bill_method_set(jsonb), public.fin_card_terms_set(jsonb) from anon;
    grant execute on function public.fin_bill_method_set(jsonb), public.fin_card_terms_set(jsonb) to authenticated;
  end if;
end $$;
