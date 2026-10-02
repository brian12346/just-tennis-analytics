-- Bank and credit card accounts from QuickBooks (the qbo function's payables_sync copies them every hour), so the
-- cash flow page can start from the bank balances QuickBooks has instead of a typed number. Balances are QuickBooks'
-- book balances (what's been entered/matched there), not a live bank feed.
create table if not exists fin.qbo_accounts (
  id          text primary key,
  name        text not null,
  type        text not null,                 -- Bank | Credit Card
  subtype     text not null default '',      -- Checking | Savings | CashOnHand | CreditCard ...
  number      text not null default '',
  balance     numeric not null default 0,    -- QuickBooks CurrentBalance
  active      boolean not null default true,
  qbo_updated timestamptz,
  synced_at   timestamptz not null default now()
);
grant select on fin.qbo_accounts to fin_reader;

-- p = {accounts: [{id, name, type, subtype, number, balance, active, updated}]}: the full list each time; accounts
-- no longer returned are marked inactive.
create or replace function public.fin_qbo_accounts_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into fin.qbo_accounts (id, name, type, subtype, number, balance, active, qbo_updated, synced_at)
  select x->>'id', coalesce(x->>'name', ''), coalesce(x->>'type', ''), coalesce(x->>'subtype', ''), coalesce(x->>'number', ''),
         coalesce((x->>'balance')::numeric, 0), coalesce((x->>'active')::boolean, true), (x->>'updated')::timestamptz, now()
  from jsonb_array_elements(coalesce(p->'accounts', '[]'::jsonb)) x
  on conflict (id) do update set name = excluded.name, type = excluded.type, subtype = excluded.subtype, number = excluded.number,
    balance = excluded.balance, active = excluded.active, qbo_updated = excluded.qbo_updated, synced_at = now();
  get diagnostics n = row_count;
  update fin.qbo_accounts set active = false
  where id not in (select x->>'id' from jsonb_array_elements(coalesce(p->'accounts', '[]'::jsonb)) x) and active;
  return n;
end $$;
revoke all on function public.fin_qbo_accounts_save(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.fin_qbo_accounts_save(jsonb) from anon, authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.fin_qbo_accounts_save(jsonb) to service_role; end if;
end $$;

-- the cash setting also takes {source: 'qbo' | 'typed', accounts: [ids]} (which bank accounts make up "cash")
