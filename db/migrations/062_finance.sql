-- Finance dashboard (finance.andersenlifestyle.com, folder finance/). Its own schema and its own allow-list:
-- being allowed on the sales dashboard (jt.app_users) gives no finance access, and the sales dashboard's read
-- function (public.jt_sql, runs as jt_reader) can't read schema fin.
--
-- First page: payables from QuickBooks. The `qbo` edge function (action payables_sync, hourly by pg_cron and from the
-- page's refresh button) copies vendors, bills, bill payments and vendor credits into fin.qbo_*.

create schema if not exists fin;

create table if not exists fin.users (
  user_id  uuid primary key,
  email    text not null,
  added_at timestamptz not null default now()
);

create or replace function fin.is_user() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from fin.users where user_id = (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid);
$$;
-- for the edge functions (service role): is this signed-in account on the finance list?
create or replace function public.fin_allowed(uid uuid) returns boolean
language sql stable security definer set search_path = '' as $$ select exists (select 1 from fin.users where user_id = uid) $$;

create table if not exists fin.qbo_vendors (
  id          text primary key,
  name        text not null,
  active      boolean not null default true,
  balance     numeric not null default 0,
  terms       text not null default '',
  email       text not null default '',
  qbo_updated timestamptz,
  synced_at   timestamptz not null default now()
);

create table if not exists fin.qbo_bills (
  id          text primary key,
  vendor_id   text not null default '',
  vendor_name text not null default '',
  doc_number  text not null default '',
  txn_date    date,
  due_date    date,
  total       numeric not null default 0,
  balance     numeric not null default 0,
  currency    text not null default 'USD',
  memo        text not null default '',
  lines       jsonb not null default '[]'::jsonb,   -- [{account, amount, description}]
  qbo_created timestamptz,
  qbo_updated timestamptz,
  synced_at   timestamptz not null default now()
);
create index if not exists qbo_bills_open on fin.qbo_bills (due_date) where balance <> 0;
create index if not exists qbo_bills_vendor on fin.qbo_bills (vendor_id);

create table if not exists fin.qbo_bill_payments (
  id          text primary key,
  vendor_id   text not null default '',
  vendor_name text not null default '',
  doc_number  text not null default '',
  txn_date    date,
  total       numeric not null default 0,
  pay_type    text not null default '',            -- Check | CreditCard
  account     text not null default '',            -- bank or card account it was paid from
  bills       jsonb not null default '[]'::jsonb,  -- [{bill_id, amount}]
  qbo_updated timestamptz,
  synced_at   timestamptz not null default now()
);
create index if not exists qbo_bill_payments_date on fin.qbo_bill_payments (txn_date);

create table if not exists fin.qbo_vendor_credits (
  id          text primary key,
  vendor_id   text not null default '',
  vendor_name text not null default '',
  doc_number  text not null default '',
  txn_date    date,
  total       numeric not null default 0,
  balance     numeric not null default 0,
  memo        text not null default '',
  qbo_updated timestamptz,
  synced_at   timestamptz not null default now()
);

create table if not exists fin.sync_state (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- p = {vendors: [...], bills: [...], payments: [...], credits: [...], finished?: {at, full}} -> rows saved.
-- Rows are upserted by QuickBooks id; with finished.full the bills/credits not in this full pass are gone from
-- QuickBooks (deleted) and are zeroed out (balance 0, memo marked) rather than removed.
create or replace function public.fin_qbo_payables_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int := 0; k int;
begin
  insert into fin.qbo_vendors (id, name, active, balance, terms, email, qbo_updated, synced_at)
  select x->>'id', coalesce(x->>'name', ''), coalesce((x->>'active')::boolean, true), coalesce((x->>'balance')::numeric, 0),
         coalesce(x->>'terms', ''), coalesce(x->>'email', ''), (x->>'updated')::timestamptz, now()
  from jsonb_array_elements(coalesce(p->'vendors', '[]'::jsonb)) x
  on conflict (id) do update set name = excluded.name, active = excluded.active, balance = excluded.balance, terms = excluded.terms,
    email = excluded.email, qbo_updated = excluded.qbo_updated, synced_at = now();
  get diagnostics k = row_count; n := n + k;

  insert into fin.qbo_bills (id, vendor_id, vendor_name, doc_number, txn_date, due_date, total, balance, currency, memo, lines, qbo_created, qbo_updated, synced_at)
  select x->>'id', coalesce(x->>'vendor_id', ''), coalesce(x->>'vendor_name', ''), coalesce(x->>'doc', ''), (x->>'date')::date, (x->>'due')::date,
         coalesce((x->>'total')::numeric, 0), coalesce((x->>'balance')::numeric, 0), coalesce(x->>'currency', 'USD'), coalesce(x->>'memo', ''),
         coalesce(x->'lines', '[]'::jsonb), (x->>'created')::timestamptz, (x->>'updated')::timestamptz, now()
  from jsonb_array_elements(coalesce(p->'bills', '[]'::jsonb)) x
  on conflict (id) do update set vendor_id = excluded.vendor_id, vendor_name = excluded.vendor_name, doc_number = excluded.doc_number,
    txn_date = excluded.txn_date, due_date = excluded.due_date, total = excluded.total, balance = excluded.balance, currency = excluded.currency,
    memo = excluded.memo, lines = excluded.lines, qbo_created = excluded.qbo_created, qbo_updated = excluded.qbo_updated, synced_at = now();
  get diagnostics k = row_count; n := n + k;

  insert into fin.qbo_bill_payments (id, vendor_id, vendor_name, doc_number, txn_date, total, pay_type, account, bills, qbo_updated, synced_at)
  select x->>'id', coalesce(x->>'vendor_id', ''), coalesce(x->>'vendor_name', ''), coalesce(x->>'doc', ''), (x->>'date')::date,
         coalesce((x->>'total')::numeric, 0), coalesce(x->>'pay_type', ''), coalesce(x->>'account', ''), coalesce(x->'bills', '[]'::jsonb),
         (x->>'updated')::timestamptz, now()
  from jsonb_array_elements(coalesce(p->'payments', '[]'::jsonb)) x
  on conflict (id) do update set vendor_id = excluded.vendor_id, vendor_name = excluded.vendor_name, doc_number = excluded.doc_number,
    txn_date = excluded.txn_date, total = excluded.total, pay_type = excluded.pay_type, account = excluded.account, bills = excluded.bills,
    qbo_updated = excluded.qbo_updated, synced_at = now();
  get diagnostics k = row_count; n := n + k;

  insert into fin.qbo_vendor_credits (id, vendor_id, vendor_name, doc_number, txn_date, total, balance, memo, qbo_updated, synced_at)
  select x->>'id', coalesce(x->>'vendor_id', ''), coalesce(x->>'vendor_name', ''), coalesce(x->>'doc', ''), (x->>'date')::date,
         coalesce((x->>'total')::numeric, 0), coalesce((x->>'balance')::numeric, 0), coalesce(x->>'memo', ''), (x->>'updated')::timestamptz, now()
  from jsonb_array_elements(coalesce(p->'credits', '[]'::jsonb)) x
  on conflict (id) do update set vendor_id = excluded.vendor_id, vendor_name = excluded.vendor_name, doc_number = excluded.doc_number,
    txn_date = excluded.txn_date, total = excluded.total, balance = excluded.balance, memo = excluded.memo, qbo_updated = excluded.qbo_updated, synced_at = now();
  get diagnostics k = row_count; n := n + k;

  if p ? 'finished' then
    if coalesce((p->'finished'->>'full')::boolean, false) then
      update fin.qbo_bills set balance = 0, memo = '[deleted in QuickBooks] ' || memo
      where synced_at < (p->'finished'->>'started')::timestamptz and balance <> 0;
      update fin.qbo_vendor_credits set balance = 0, memo = '[deleted in QuickBooks] ' || memo
      where synced_at < (p->'finished'->>'started')::timestamptz and balance <> 0;
    end if;
    insert into fin.sync_state (key, value, updated_at) values ('qbo_payables', p->'finished', now())
    on conflict (key) do update set value = excluded.value, updated_at = now();
  end if;
  return n;
end $$;

-- bills with their status and age, and the sales dashboard's invoice/PO they came from (when sent from Seller Sage)
create or replace view fin.v_bills as
select b.*,
       case when b.balance = 0 then 'paid' when b.due_date is null or b.due_date >= current_date then 'open' else 'overdue' end as status,
       case when b.balance = 0 or b.due_date is null or b.due_date >= current_date then 0 else current_date - b.due_date end as days_overdue,
       case when b.balance = 0 then null
            when b.due_date is null or b.due_date >= current_date then 'current'
            when current_date - b.due_date <= 30 then '1-30'
            when current_date - b.due_date <= 60 then '31-60'
            when current_date - b.due_date <= 90 then '61-90'
            else '90+' end as aging,
       i.id as invoice_id, i.po_no, i.order_id as po_id
from fin.qbo_bills b
left join jt.invoices i on i.qbo_bill_id = b.id;

-- Read queries from the finance page. Runs as fin_reader: schema fin plus the shared sales data in jt, read-only.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'fin_reader') then create role fin_reader nologin; end if;
end $$;
grant usage on schema fin, jt to fin_reader;
grant select on all tables in schema fin to fin_reader;
grant select on all tables in schema jt to fin_reader;
alter default privileges in schema fin grant select on tables to fin_reader;
alter default privileges in schema jt grant select on tables to fin_reader;
grant fin_reader to postgres;

create or replace function public.fin_sql(q text) returns json
language plpgsql security definer set search_path = '' as $$
declare r json;
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if q !~* '^\s*(select|with)\s' then raise exception 'read queries only'; end if;
  set local statement_timeout = '25s';
  execute 'select coalesce(json_agg(t), ''[]''::json) from (' || q || ') t' into r;
  return r;
end $$;
grant create on schema public to fin_reader;
alter function public.fin_sql(text) owner to fin_reader;
revoke create on schema public from fin_reader;

-- is the signed-in account on the finance list? (the page shows "no access" instead of failing queries)
create or replace function public.fin_whoami() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('allowed', fin.is_user());
$$;

revoke all on function public.fin_sql(text), public.fin_whoami(), public.fin_allowed(uuid), public.fin_qbo_payables_save(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_sql(text), public.fin_whoami(), public.fin_allowed(uuid), public.fin_qbo_payables_save(jsonb) from anon;
    grant execute on function public.fin_sql(text), public.fin_whoami() to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_allowed(uuid), public.fin_qbo_payables_save(jsonb) to service_role;
  end if;
end $$;

-- when the last payables pass ran (the qbo function uses it for "only what changed since")
create or replace function public.fin_qbo_last_sync() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select value from fin.sync_state where key = 'qbo_payables'), '{}'::jsonb);
$$;
revoke all on function public.fin_qbo_last_sync() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.fin_qbo_last_sync() from anon, authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.fin_qbo_last_sync() to service_role; end if;
end $$;
