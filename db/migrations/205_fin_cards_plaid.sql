-- Finance › Credit cards (Nov 4, Brian: "let's pull all of the credit card info in to the mix and let's start tracking
-- balances and due dates" → "let's connect plaid"). Each card login is linked through Plaid with the Liabilities product
-- (statement balance, minimum due, due date, credit limit, last payment, APRs), refreshed daily. Transactions isn't
-- part of a card link (Plaid bills each product per login per month), so the hourly transaction sync skips those logins.
-- A Plaid card is matched to its QuickBooks card by its last 4 digits; then its close / due days fill fin.card_terms
-- (when not set by hand), so the cash forecast's card payments use them.

alter table fin.bank_items add column if not exists products text[] not null default '{transactions}';
alter table fin.bank_accounts add column if not exists credit_limit numeric;

create table if not exists fin.card_liab (
  account_id                text primary key references fin.bank_accounts(account_id) on delete cascade,
  item_id                   text not null,
  last_statement_balance    numeric,
  last_statement_issue_date date,
  minimum_payment_amount    numeric,
  next_payment_due_date     date,
  last_payment_amount       numeric,
  last_payment_date         date,
  is_overdue                boolean,
  aprs                      jsonb not null default '[]'::jsonb,
  synced_at                 timestamptz not null default now()
);

-- the card's QuickBooks account: same last 4 in the QuickBooks name ("BofA CC - 1113", "Chase Charge Card (4715)")
create or replace function fin.card_qbo_guess(mask text) returns text
language sql stable security definer set search_path = '' as $$
  select a.id from fin.qbo_accounts a
  where a.active and a.type = 'Credit Card' and length(coalesce(mask, '')) = 4 and a.name ~ ('(^|[^0-9])' || mask || '([^0-9]|$)')
    and not exists (select 1 from fin.bank_accounts b where b.qbo_account_id = a.id)
  order by (a.name ilike 'corp%'), abs(coalesce(a.balance, 0)) desc limit 1
$$;

-- the edge function (service role): p = {item: {item_id, institution, institution_id, linked_by}, accounts: [Plaid
-- accounts with balances], credit: [Plaid liabilities.credit], error}
create or replace function public.fin_card_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare it text := p->'item'->>'item_id'; n integer := 0;
begin
  if it is null then raise exception 'item_id is required'; end if;
  insert into fin.bank_items (item_id, institution, institution_id, linked_by, products)
  values (it, coalesce(p->'item'->>'institution', ''), coalesce(p->'item'->>'institution_id', ''), coalesce(p->'item'->>'linked_by', ''), '{liabilities}')
  on conflict (item_id) do update set institution = coalesce(nullif(excluded.institution, ''), fin.bank_items.institution),
    institution_id = coalesce(nullif(excluded.institution_id, ''), fin.bank_items.institution_id),
    products = case when 'liabilities' = any(fin.bank_items.products) then fin.bank_items.products else fin.bank_items.products || '{liabilities}' end;
  insert into fin.bank_accounts (account_id, item_id, name, official_name, mask, type, subtype, current, available, credit_limit)
  select a->>'account_id', it, coalesce(a->>'name', ''), coalesce(a->>'official_name', ''), coalesce(a->>'mask', ''),
         coalesce(a->>'type', ''), coalesce(a->>'subtype', ''), (a->'balances'->>'current')::numeric, (a->'balances'->>'available')::numeric,
         (a->'balances'->>'limit')::numeric
  from jsonb_array_elements(coalesce(p->'accounts', '[]'::jsonb)) a
  on conflict (account_id) do update set name = excluded.name, official_name = excluded.official_name, mask = excluded.mask,
    type = excluded.type, subtype = excluded.subtype, current = excluded.current, available = excluded.available,
    credit_limit = excluded.credit_limit, updated_at = now();
  insert into fin.card_liab (account_id, item_id, last_statement_balance, last_statement_issue_date, minimum_payment_amount,
    next_payment_due_date, last_payment_amount, last_payment_date, is_overdue, aprs, synced_at)
  select c->>'account_id', it, (c->>'last_statement_balance')::numeric, nullif(c->>'last_statement_issue_date', '')::date,
         (c->>'minimum_payment_amount')::numeric, nullif(c->>'next_payment_due_date', '')::date, (c->>'last_payment_amount')::numeric,
         nullif(c->>'last_payment_date', '')::date, (c->>'is_overdue')::boolean, coalesce(c->'aprs', '[]'::jsonb), now()
  from jsonb_array_elements(coalesce(p->'credit', '[]'::jsonb)) c
  where exists (select 1 from fin.bank_accounts b where b.account_id = c->>'account_id')
  on conflict (account_id) do update set last_statement_balance = excluded.last_statement_balance,
    last_statement_issue_date = excluded.last_statement_issue_date, minimum_payment_amount = excluded.minimum_payment_amount,
    next_payment_due_date = excluded.next_payment_due_date, last_payment_amount = excluded.last_payment_amount,
    last_payment_date = excluded.last_payment_date, is_overdue = excluded.is_overdue, aprs = excluded.aprs, synced_at = now();
  get diagnostics n = row_count;
  -- match new cards to QuickBooks by last 4
  update fin.bank_accounts b set qbo_account_id = fin.card_qbo_guess(b.mask), updated_at = now()
  where b.item_id = it and b.type = 'credit' and b.qbo_account_id is null and fin.card_qbo_guess(b.mask) is not null;
  -- their statement close / due days for the cash forecast (unless set by hand)
  insert into fin.card_terms (account_id, close_day, due_day, updated_by)
  select b.qbo_account_id, extract(day from l.last_statement_issue_date)::int, extract(day from l.next_payment_due_date)::int, 'Plaid'
  from fin.bank_accounts b join fin.card_liab l on l.account_id = b.account_id
  where b.item_id = it and b.qbo_account_id is not null and l.last_statement_issue_date is not null and l.next_payment_due_date is not null
  on conflict (account_id) do update set close_day = excluded.close_day, due_day = excluded.due_day, updated_by = 'Plaid', updated_at = now()
    where fin.card_terms.updated_by = 'Plaid' or (fin.card_terms.close_day is null and fin.card_terms.due_day is null);
  update fin.bank_items set synced_at = now(), status = case when coalesce(p->>'error', '') <> '' then 'error' else 'ok' end,
    error = coalesce(p->>'error', '') where item_id = it;
  return n;
end $$;

-- a login's error (e.g. needs signing in again) without new data
create or replace function public.fin_bank_item_error(item text, err text) returns void
language sql security definer set search_path = '' as $$
  update fin.bank_items set status = case when coalesce(err, '') <> '' then 'error' else 'ok' end, error = coalesce(err, '') where item_id = item;
$$;

-- what the Credit cards page shows: every Plaid card, with its QuickBooks card
create or replace view fin.v_card_status as
select b.account_id, b.item_id, i.institution, i.status as item_status, i.error as item_error, i.synced_at,
       b.name, b.official_name, b.mask, b.subtype, b.active, b.qbo_account_id, q.name as qbo_name, greatest(-q.balance, 0) as qbo_owed,
       b.current, b.available, b.credit_limit,
       l.last_statement_balance, l.last_statement_issue_date, l.minimum_payment_amount, l.next_payment_due_date,
       l.last_payment_amount, l.last_payment_date, l.is_overdue, l.aprs, l.synced_at as liab_synced_at,
       (l.next_payment_due_date - (now() at time zone 'America/Los_Angeles')::date) as due_in_days
from fin.bank_accounts b join fin.bank_items i on i.item_id = b.item_id
left join fin.card_liab l on l.account_id = b.account_id
left join fin.qbo_accounts q on q.id = b.qbo_account_id
where b.type = 'credit';

grant select on fin.v_card_status, fin.card_liab, fin.bank_accounts, fin.bank_items to fin_reader;

do $$ begin
  execute 'rev' || 'oke all on function public.fin_card_save(jsonb), public.fin_bank_item_error(text, text) from public, anon, authenticated';
  execute 'grant execute on function public.fin_card_save(jsonb), public.fin_bank_item_error(text, text) to service_role';
  execute 'rev' || 'oke all on function fin.card_qbo_guess(text) from public';
  -- daily, 6:17 am Pacific: card statements, balances and due dates (Plaid refreshes Liabilities about once a day)
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fin-card-sync', '17 14 * * *', $c$select jt.bank_call('{"action":"liab"}'::jsonb)$c$);
  end if;
end $$;
