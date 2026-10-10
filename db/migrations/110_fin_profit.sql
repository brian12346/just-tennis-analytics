-- Finance › Profit (Brian, Oct 9): overall profit by month since Jan 2025 = the sales dashboard's profit (sales − cost of
-- goods − shipping labels − Amazon/payment fees) − business expenses from QuickBooks (payroll, rent, ads, software …).
--
-- The `qbo` edge function (action pl_sync: daily by pg_cron and from the page's refresh button) copies the QuickBooks
-- Profit and Loss report by month into fin.qbo_pl, one row per account per month. Each account is counted as a business
-- expense or not (already in the dashboard's profit, e.g. cost of goods and Amazon fees), and put in a group, by
-- fin.pl_account_class; fin.pl_rules holds the changes made on the page.

create table if not exists fin.qbo_pl (
  section     text not null,                 -- Income, COGS, Expenses, OtherIncome, OtherExpenses
  account_key text not null,                 -- QuickBooks account id (or its name when the report has none)
  month       date not null,                 -- first of the month
  account     text not null default '',
  parent      text not null default '',      -- the account's parent(s) in the report, " › " between
  amount      numeric not null default 0,
  synced_at   timestamptz not null default now(),
  primary key (section, account_key, month)
);

create table if not exists fin.pl_rules (
  account_key text primary key,
  grp         text,                          -- null = the default group
  include     boolean,                       -- null = the default
  updated_at  timestamptz not null default now(),
  updated_by  text not null default ''
);

-- p = {start: 'YYYY-MM-DD', end: 'YYYY-MM-DD', rows: [{section, key, account, parent, month, amount}]} -> rows saved.
-- Accounts in the months covered that aren't in this pass are set to 0 (nothing is removed).
create or replace function public.fin_qbo_pl_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update fin.qbo_pl set amount = 0, synced_at = now()
  where month >= date_trunc('month', (p->>'start')::date) and month <= (p->>'end')::date and amount <> 0;
  insert into fin.qbo_pl (section, account_key, month, account, parent, amount, synced_at)
  select x->>'section', x->>'key', date_trunc('month', (x->>'month')::date)::date, coalesce(x->>'account', ''), coalesce(x->>'parent', ''),
         sum(coalesce((x->>'amount')::numeric, 0)), now()
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x
  group by 1, 2, 3, 4, 5
  on conflict (section, account_key, month) do update set account = excluded.account, parent = excluded.parent, amount = excluded.amount, synced_at = now();
  get diagnostics n = row_count;
  insert into fin.sync_state (key, value, updated_at) values ('qbo_pl', jsonb_build_object('at', now(), 'start', p->>'start', 'end', p->>'end', 'rows', n), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return n;
end $$;
revoke all on function public.fin_qbo_pl_save(jsonb) from public;

-- the default for an account: Income and Cost of goods sold are already in the dashboard's profit (its sales, cost of
-- goods, labels and Amazon/payment fees); expenses count, grouped by name
create or replace function fin.pl_default(section text, account text, parent text) returns jsonb
language sql immutable set search_path = '' as $$
  select case
    when section in ('Income', 'COGS') then jsonb_build_object('include', false, 'grp', 'In dashboard profit')
    when section = 'OtherIncome' then jsonb_build_object('include', true, 'grp', 'Other income')
    else jsonb_build_object('include', true, 'grp', case
      when t ~* 'payroll|wage|salar|workers.? comp|employee benefit|contract labor|payroll tax|401k|health insurance|uniform' then 'Payroll & staff'
      when t ~* 'advertis|marketing|google ads|facebook|meta ads|promotion' then 'Advertising'
      when t ~* 'rent|lease|utilit|internet|phone|cleaning|janitor|repair|maintenance' then 'Rent & facilities'
      when t ~* 'software|apps|subscription|membership' then 'Software & subscriptions'
      when t ~* 'meal|lunch|travel|hotel|airfare|taxi|ride|vehicle|mileage' then 'Meals & travel'
      when t ~* 'insurance' then 'Insurance'
      when t ~* 'interest|bank fee|service charge|loan' then 'Bank fees & interest'
      when t ~* 'tax' then 'Taxes'
      when t ~* 'accounting|legal|professional' then 'Professional fees'
      else 'Other expenses' end)
  end
  from (select coalesce(parent, '') || ' › ' || coalesce(account, '') as t) x;
$$;

-- every account in the report with its total since Jan 2025, its default and what's used (rules over defaults)
create or replace view fin.pl_account_class as
select a.section, a.account_key, a.account, a.parent, a.total, a.months,
       coalesce(r.include, (d->>'include')::boolean) as include,
       coalesce(nullif(r.grp, ''), d->>'grp') as grp,
       (d->>'include')::boolean as default_include, d->>'grp' as default_grp,
       r.updated_at as rule_at, r.updated_by as rule_by
from (select section, account_key, max(account) as account, max(parent) as parent, sum(amount) as total, count(*) filter (where amount <> 0) as months
      from fin.qbo_pl group by 1, 2) a
cross join lateral (select fin.pl_default(a.section, a.account, a.parent) as d) dd
left join fin.pl_rules r on r.account_key = a.account_key;

-- business expenses by month and group (income groups come in negative: they add to profit)
create or replace view fin.v_pl_expenses as
select p.month, c.grp, p.section, p.account_key, c.account, c.parent,
       case when p.section in ('Income', 'OtherIncome') then -p.amount else p.amount end as amount
from fin.qbo_pl p join fin.pl_account_class c on c.section = p.section and c.account_key = p.account_key
where c.include and p.amount <> 0;

-- p = {account_key, include?: bool|null, grp?: text|null}; null / missing = back to the default
create or replace function public.fin_pl_rule_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare k text := p->>'account_key';
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(k, '') = '' then raise exception 'account_key is required'; end if;
  insert into fin.pl_rules (account_key, grp, include, updated_at, updated_by)
  values (k, nullif(p->>'grp', ''), (p->>'include')::boolean, now(),
          coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', ''))
  on conflict (account_key) do update set grp = excluded.grp, include = excluded.include, updated_at = now(), updated_by = excluded.updated_by;
  return true;
end $$;
revoke all on function public.fin_pl_rule_set(jsonb) from public;

grant select on fin.qbo_pl, fin.pl_rules, fin.pl_account_class, fin.v_pl_expenses to fin_reader;
grant execute on function fin.pl_default(text, text, text) to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_qbo_pl_save(jsonb), public.fin_pl_rule_set(jsonb) from anon;
    grant execute on function public.fin_pl_rule_set(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_qbo_pl_save(jsonb) to service_role;
  end if;
end $$;

-- the P&L once a day (6:20 am Pacific ≈ 13:20 UTC), after the night's entries
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fin-qbo-pl', '20 13 * * *', $c$select jt.qbo_call('{"action":"pl_sync"}'::jsonb)$c$);
  end if;
end $$;
