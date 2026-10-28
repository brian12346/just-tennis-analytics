-- Finance › Transactions: every card and bank transaction, classified in Finance instead of QuickBooks (Brian, Oct 28:
-- "a way to show all of the transactions that have hit my CCs and bank accounts and classify them in finance rather than
-- quickbooks"). Decided: a Plaid live feed; once classified, Finance posts it to QuickBooks (the QuickBooks bank feed then
-- just matches it). Nothing is posted by itself — posting is a button.
--
-- The `bank` edge function talks to Plaid (link a bank, pull transactions with /transactions/sync) and to QuickBooks
-- (find what's already there, learn how past payees were categorized, post). Plaid's keys live in Vault (plaid_client_id,
-- plaid_secret, plaid_env); each linked bank's access token too (plaid_access_<item id>) — never in tables.
-- Amounts are Plaid's: positive = money out of the account (a purchase, a payment out), negative = money in.

create table if not exists fin.bank_items (
  item_id        text primary key,
  institution    text not null default '',
  institution_id text not null default '',
  cursor         text,
  status         text not null default 'ok',     -- ok | error (relink)
  error          text not null default '',
  linked_by      text not null default '',
  linked_at      timestamptz not null default now(),
  synced_at      timestamptz
);
create table if not exists fin.bank_accounts (
  account_id     text primary key,
  item_id        text not null references fin.bank_items(item_id) on delete cascade,
  name           text not null default '',
  official_name  text not null default '',
  mask           text not null default '',
  type           text not null default '',       -- depository | credit | …
  subtype        text not null default '',
  qbo_account_id text,                           -- the QuickBooks bank / card account it is
  active         boolean not null default true,  -- false: hidden, not classified
  current        numeric,
  available      numeric,
  updated_at     timestamptz not null default now()
);
create table if not exists fin.bank_tx (
  tx_id          text primary key,
  account_id     text not null,
  item_id        text not null,
  date           date not null,
  authorized_date date,
  amount         numeric not null,
  name           text not null default '',
  merchant       text not null default '',
  category       text not null default '',       -- Plaid's personal finance category (detailed)
  channel        text not null default '',
  pending        boolean not null default false,
  check_number   text not null default '',
  raw            jsonb not null default '{}'::jsonb,
  first_seen     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  removed_at     timestamptz
);
create index if not exists bank_tx_acct_date on fin.bank_tx (account_id, date);
-- what it is: kind expense | income | transfer | skip; account = the QuickBooks category (or, for a transfer, the other
-- bank/card account); status draft (suggested or picked, not checked) → ready → posted | linked (already in QuickBooks)
create table if not exists fin.bank_class (
  tx_id          text primary key,
  kind           text not null default 'expense' check (kind in ('expense', 'income', 'transfer', 'skip')),
  account_id     text,
  vendor_id      text,
  vendor_name    text not null default '',
  memo           text not null default '',
  source         text not null default 'manual',  -- manual | rule | history | match | quickbooks
  status         text not null default 'draft' check (status in ('draft', 'ready', 'posted', 'linked', 'skipped')),
  qbo_type       text not null default '',
  qbo_id         text not null default '',
  posted_at      timestamptz,
  posted_by      text not null default '',
  set_by         text not null default '',
  set_at         timestamptz not null default now()
);
create table if not exists fin.bank_rules (
  id             bigserial primary key,
  pattern        text not null,                  -- words the description / merchant contains (case doesn't matter)
  direction      text not null default 'any' check (direction in ('out', 'in', 'any')),
  bank_account   text,                           -- only this linked account (null: any)
  kind           text not null default 'expense' check (kind in ('expense', 'income', 'transfer', 'skip')),
  account_id     text,
  vendor_id      text,
  vendor_name    text not null default '',
  memo           text not null default '',
  created_by     text not null default '',
  created_at     timestamptz not null default now()
);
-- how payees were categorized in QuickBooks (Purchases and Deposits, last 12 months): the "last time" suggestion
create table if not exists fin.qbo_payee_hist (
  payee_key      text not null,                  -- lower-case words of the payee / description
  direction      text not null,                  -- out | in
  account_id     text not null,
  vendor_id      text not null default '',
  vendor_name    text not null default '',
  n              integer not null default 0,
  last_date      date,
  primary key (payee_key, direction, account_id)
);
alter table fin.bank_items enable row level security;
alter table fin.bank_accounts enable row level security;
alter table fin.bank_tx enable row level security;
alter table fin.bank_class enable row level security;
alter table fin.bank_rules enable row level security;
alter table fin.qbo_payee_hist enable row level security;

-- only transactions on or after this day get classified (older ones are history: shown, not worked on)
insert into fin.settings (key, value) values ('bank', '{"start": "2026-10-01"}'::jsonb) on conflict (key) do nothing;

-- a payee's key: lower-case words, no numbers / store numbers / card noise ("SQ *BLUE BOTTLE #123 SF" → "blue bottle")
create or replace function fin.payee_key(s text) returns text
language sql immutable set search_path = '' as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(lower(coalesce(s, '')),
    '^(sq \*|sp \*|tst\* |pp\*|paypal \*|in \*|py \*|pos |ach |debit |purchase |recurring )', ''),
    '[^a-z ]+', ' ', 'g'), '\m[a-z]\M', '', 'g'), '\s+', ' ', 'g'))
$$;

-- ---- for the edge function (service role only)
create or replace function public.fin_plaid_creds() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return jsonb_build_object(
    'plaid', (select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb) from vault.decrypted_secrets where name in ('plaid_client_id', 'plaid_secret', 'plaid_env')),
    'tokens', (select coalesce(jsonb_object_agg(substr(name, 14), decrypted_secret), '{}'::jsonb) from vault.decrypted_secrets where name like 'plaid_access_%'));
end $$;
create or replace function public.fin_plaid_token_save(item text, tok text) returns void
language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  select id into sid from vault.secrets where name = 'plaid_access_' || item;
  if sid is null then perform vault.create_secret(tok, 'plaid_access_' || item, 'Plaid access token (Finance › Transactions)');
  else perform vault.update_secret(sid, tok); end if;
end $$;
-- p = {item: {item_id, institution, institution_id, linked_by}, accounts: [...], added: [...], modified: [...],
--      removed: [tx ids], cursor, error}
create or replace function public.fin_bank_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare it text := p->'item'->>'item_id'; n integer := 0; k integer;
begin
  if it is null then raise exception 'item_id is required'; end if;
  insert into fin.bank_items (item_id, institution, institution_id, linked_by)
  values (it, coalesce(p->'item'->>'institution', ''), coalesce(p->'item'->>'institution_id', ''), coalesce(p->'item'->>'linked_by', ''))
  on conflict (item_id) do update set institution = coalesce(nullif(excluded.institution, ''), fin.bank_items.institution),
    institution_id = coalesce(nullif(excluded.institution_id, ''), fin.bank_items.institution_id);
  insert into fin.bank_accounts (account_id, item_id, name, official_name, mask, type, subtype, current, available)
  select a->>'account_id', it, coalesce(a->>'name', ''), coalesce(a->>'official_name', ''), coalesce(a->>'mask', ''),
         coalesce(a->>'type', ''), coalesce(a->>'subtype', ''), (a->'balances'->>'current')::numeric, (a->'balances'->>'available')::numeric
  from jsonb_array_elements(coalesce(p->'accounts', '[]'::jsonb)) a
  on conflict (account_id) do update set name = excluded.name, official_name = excluded.official_name, mask = excluded.mask,
    type = excluded.type, subtype = excluded.subtype, current = excluded.current, available = excluded.available, updated_at = now();
  insert into fin.bank_tx (tx_id, account_id, item_id, date, authorized_date, amount, name, merchant, category, channel, pending, check_number, raw)
  select t->>'transaction_id', t->>'account_id', it, (t->>'date')::date, nullif(t->>'authorized_date', '')::date, (t->>'amount')::numeric,
         coalesce(t->>'name', ''), coalesce(t->>'merchant_name', ''), coalesce(t->'personal_finance_category'->>'detailed', ''),
         coalesce(t->>'payment_channel', ''), coalesce((t->>'pending')::boolean, false), coalesce(t->>'check_number', ''), t
  from jsonb_array_elements(coalesce(p->'added', '[]'::jsonb) || coalesce(p->'modified', '[]'::jsonb)) t
  on conflict (tx_id) do update set account_id = excluded.account_id, date = excluded.date, authorized_date = excluded.authorized_date,
    amount = excluded.amount, name = excluded.name, merchant = excluded.merchant, category = excluded.category, channel = excluded.channel,
    pending = excluded.pending, check_number = excluded.check_number, raw = excluded.raw, updated_at = now(), removed_at = null;
  get diagnostics k = row_count; n := n + k;
  -- a pending transaction that posts comes back under a new id: its classification moves with it
  update fin.bank_class c set tx_id = t.tx_id
  from fin.bank_tx t where t.raw->>'pending_transaction_id' = c.tx_id and c.status in ('draft', 'ready', 'skipped')
    and not exists (select 1 from fin.bank_class c2 where c2.tx_id = t.tx_id);
  update fin.bank_tx set removed_at = now() where tx_id in (select jsonb_array_elements_text(coalesce(p->'removed', '[]'::jsonb))) and removed_at is null;
  update fin.bank_items set cursor = coalesce(p->>'cursor', cursor), synced_at = case when p ? 'cursor' then now() else synced_at end,
    status = case when coalesce(p->>'error', '') <> '' then 'error' when p ? 'cursor' then 'ok' else status end,
    error = case when p ? 'error' then coalesce(p->>'error', '') else error end
  where item_id = it;
  return n;
end $$;
-- p = {rows: [{payee, direction, account_id, vendor_id, vendor_name, date}], clear: true on the first batch}
create or replace function public.fin_qbo_payee_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if coalesce((p->>'clear')::boolean, false) then delete from fin.qbo_payee_hist where true; end if;
  insert into fin.qbo_payee_hist (payee_key, direction, account_id, vendor_id, vendor_name, n, last_date)
  select fin.payee_key(r->>'payee'), r->>'direction', r->>'account_id', coalesce(max(r->>'vendor_id'), ''), coalesce(max(r->>'vendor_name'), ''), count(*), max((r->>'date')::date)
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) r
  where fin.payee_key(r->>'payee') <> '' and r->>'account_id' is not null
  group by 1, 2, 3
  on conflict (payee_key, direction, account_id) do update set n = fin.qbo_payee_hist.n + excluded.n,
    last_date = greatest(fin.qbo_payee_hist.last_date, excluded.last_date),
    vendor_id = coalesce(nullif(excluded.vendor_id, ''), fin.qbo_payee_hist.vendor_id), vendor_name = coalesce(nullif(excluded.vendor_name, ''), fin.qbo_payee_hist.vendor_name);
  get diagnostics n = row_count; return n;
end $$;
-- the post / link result. p = {tx_ids, status (posted | linked), qbo_type, qbo_id, by}
create or replace function public.fin_bank_posted(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into fin.bank_class (tx_id, kind, status, source, qbo_type, qbo_id, posted_at, posted_by, set_by)
  select x, 'expense', p->>'status', 'quickbooks', coalesce(p->>'qbo_type', ''), coalesce(p->>'qbo_id', ''), now(), coalesce(p->>'by', ''), coalesce(p->>'by', '')
  from jsonb_array_elements_text(coalesce(p->'tx_ids', '[]'::jsonb)) x
  on conflict (tx_id) do update set status = excluded.status, qbo_type = excluded.qbo_type, qbo_id = excluded.qbo_id,
    posted_at = now(), posted_by = excluded.posted_by,
    source = case when fin.bank_class.status in ('draft', 'ready') and excluded.status = 'linked' then 'quickbooks' else fin.bank_class.source end;
  get diagnostics n = row_count; return n;
end $$;

-- ---- what the page shows: each transaction with its classification, or else a suggestion
--   1. a transfer between two linked accounts (same amount, opposite sign, within 4 days) — e.g. paying a card from checking
--   2. a bill payment QuickBooks already has (same account, amount, within 5 days) → already in QuickBooks
--   3. a rule (newest first)   4. how QuickBooks categorized this payee most often
create or replace view fin.v_bank_tx as
with acct as (select a.*, i.institution from fin.bank_accounts a join fin.bank_items i using (item_id)),
st as (select coalesce((select (value->>'start')::date from fin.settings where key = 'bank'), date '2026-10-01') as start),
t as (select t.*, a.qbo_account_id, a.institution, a.name as acct_name, a.mask, a.type as acct_type, a.active,
         fin.payee_key(coalesce(nullif(t.merchant, ''), t.name)) as pkey
      from fin.bank_tx t join acct a using (account_id) where t.removed_at is null),
xfer as (select distinct on (t.tx_id) t.tx_id, o.qbo_account_id as other_acct, o.tx_id as other_tx
         from t join t o on o.account_id <> t.account_id and o.amount = -t.amount and abs(o.date - t.date) <= 4 and o.qbo_account_id is not null
         order by t.tx_id, abs(o.date - t.date)),
bp as (select distinct on (t.tx_id) t.tx_id, b.id as bp_id, b.vendor_name
       from t join fin.qbo_accounts qa on qa.id = t.qbo_account_id
       join fin.qbo_bill_payments b on b.account = qa.name and b.total = t.amount and abs(b.txn_date - t.date) <= 5
       where t.amount > 0 order by t.tx_id, abs(b.txn_date - t.date)),
rule as (select distinct on (t.tx_id) t.tx_id, r.id as rule_id, r.kind, r.account_id, r.vendor_id, r.vendor_name, r.memo
         from t join fin.bank_rules r on lower(t.name || ' ' || t.merchant) like '%' || lower(r.pattern) || '%'
           and (r.direction = 'any' or (r.direction = 'out') = (t.amount > 0)) and (r.bank_account is null or r.bank_account = t.account_id)
         order by t.tx_id, length(r.pattern) desc, r.id desc),
hist as (select distinct on (t.tx_id) t.tx_id, h.account_id, h.vendor_id, h.vendor_name, h.n
         from t join fin.qbo_payee_hist h on h.payee_key = t.pkey and h.direction = case when t.amount > 0 then 'out' else 'in' end
         where t.pkey <> '' order by t.tx_id, h.n desc, h.last_date desc)
select t.tx_id, t.account_id, t.institution, t.acct_name, t.mask, t.acct_type, t.qbo_account_id, t.active, t.date, t.amount, t.name, t.merchant,
       t.category, t.pending, t.check_number, t.date >= st.start as in_scope,
       c.status, c.kind, c.account_id as class_account, c.vendor_id, c.vendor_name, c.memo, c.source, c.qbo_type, c.qbo_id, c.posted_at, c.posted_by,
       -- the suggestion (when it isn't classified yet)
       case when xfer.tx_id is not null then 'transfer' when bp.tx_id is not null then 'billpay' when rule.tx_id is not null then 'rule' when hist.tx_id is not null then 'history' end as sug_source,
       case when xfer.tx_id is not null then 'transfer' when rule.tx_id is not null then rule.kind when hist.tx_id is not null then case when t.amount > 0 then 'expense' else 'income' end end as sug_kind,
       coalesce(xfer.other_acct, rule.account_id, hist.account_id) as sug_account,
       coalesce(rule.vendor_id, hist.vendor_id, '') as sug_vendor_id, coalesce(rule.vendor_name, hist.vendor_name, bp.vendor_name, '') as sug_vendor_name,
       coalesce(rule.memo, '') as sug_memo, rule.rule_id, xfer.other_tx, bp.bp_id
from t cross join st
left join fin.bank_class c using (tx_id)
left join xfer using (tx_id) left join bp using (tx_id) left join rule using (tx_id) left join hist using (tx_id);

-- ---- the page's writes (finance users)
-- p = {account_id, qbo_account_id?, active?}
create or replace function public.fin_bank_account_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p ? 'qbo_account_id' and nullif(p->>'qbo_account_id', '') is not null
     and not exists (select 1 from fin.qbo_accounts where id = p->>'qbo_account_id' and type in ('Bank', 'Credit Card')) then
    raise exception 'not a QuickBooks bank account or card' using errcode = '22023';
  end if;
  update fin.bank_accounts set qbo_account_id = case when p ? 'qbo_account_id' then nullif(p->>'qbo_account_id', '') else qbo_account_id end,
    active = coalesce((p->>'active')::boolean, active), updated_at = now()
  where account_id = p->>'account_id';
  return found;
end $$;
-- p = {tx_ids, kind?, account_id?, vendor_id?, vendor_name?, memo?, status?, source?}; status 'draft' with no kind clears it
create or replace function public.fin_bank_class_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', ''); n integer;
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p->>'status' = 'clear' then
    delete from fin.bank_class where tx_id in (select jsonb_array_elements_text(p->'tx_ids')) and status in ('draft', 'ready', 'skipped', 'linked');
    get diagnostics n = row_count; return n;
  end if;
  if coalesce(p->>'status', 'draft') not in ('draft', 'ready', 'skipped') then raise exception 'status must be draft, ready or skipped'; end if;
  insert into fin.bank_class (tx_id, kind, account_id, vendor_id, vendor_name, memo, source, status, set_by)
  select x, coalesce(p->>'kind', case when coalesce(p->>'status', '') = 'skipped' then 'skip' else 'expense' end), nullif(p->>'account_id', ''),
         nullif(p->>'vendor_id', ''), coalesce(p->>'vendor_name', ''), coalesce(p->>'memo', ''), coalesce(p->>'source', 'manual'), coalesce(p->>'status', 'draft'), who
  from jsonb_array_elements_text(p->'tx_ids') x
  on conflict (tx_id) do update set
    kind = case when p ? 'kind' then excluded.kind when excluded.status = 'skipped' then 'skip' else fin.bank_class.kind end,
    account_id = case when p ? 'account_id' then excluded.account_id else fin.bank_class.account_id end,
    vendor_id = case when p ? 'vendor_id' then excluded.vendor_id else fin.bank_class.vendor_id end,
    vendor_name = case when p ? 'vendor_name' then excluded.vendor_name else fin.bank_class.vendor_name end,
    memo = case when p ? 'memo' then excluded.memo else fin.bank_class.memo end,
    source = case when p ? 'source' then excluded.source else fin.bank_class.source end,
    status = case when p ? 'status' then excluded.status else fin.bank_class.status end,
    set_by = who, set_at = now()
  where fin.bank_class.status not in ('posted', 'linked');
  get diagnostics n = row_count; return n;
end $$;
-- p = {pattern, direction, bank_account, kind, account_id, vendor_id, vendor_name, memo} | {id, delete: true}
create or replace function public.fin_bank_rule_set(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', ''); rid bigint;
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce((p->>'delete')::boolean, false) then delete from fin.bank_rules where id = (p->>'id')::bigint; return (p->>'id')::bigint; end if;
  if length(btrim(coalesce(p->>'pattern', ''))) < 3 then raise exception 'the rule needs at least 3 letters to look for'; end if;
  insert into fin.bank_rules (pattern, direction, bank_account, kind, account_id, vendor_id, vendor_name, memo, created_by)
  values (btrim(p->>'pattern'), coalesce(nullif(p->>'direction', ''), 'any'), nullif(p->>'bank_account', ''), coalesce(nullif(p->>'kind', ''), 'expense'),
          nullif(p->>'account_id', ''), nullif(p->>'vendor_id', ''), coalesce(p->>'vendor_name', ''), coalesce(p->>'memo', ''), who)
  returning id into rid;
  return rid;
end $$;
-- p = {start: 'YYYY-MM-DD'}
create or replace function public.fin_bank_start_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into fin.settings (key, value) values ('bank', jsonb_build_object('start', (p->>'start')::date))
  on conflict (key) do update set value = fin.settings.value || jsonb_build_object('start', (p->>'start')::date), updated_at = now();
  return true;
end $$;

-- SQL → the bank function (scheduler; maintenance)
create or replace function jt.bank_call(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/bank', body := p, timeout_milliseconds := 120000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $$;

do $$ begin
  execute 'rev' || 'oke all on function public.fin_plaid_creds(), public.fin_plaid_token_save(text, text), public.fin_bank_save(jsonb), public.fin_qbo_payee_save(jsonb), public.fin_bank_posted(jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.fin_plaid_creds(), public.fin_plaid_token_save(text, text), public.fin_bank_save(jsonb), public.fin_qbo_payee_save(jsonb), public.fin_bank_posted(jsonb) to service_role';
  execute 'rev' || 'oke all on function public.fin_bank_account_set(jsonb), public.fin_bank_class_set(jsonb), public.fin_bank_rule_set(jsonb), public.fin_bank_start_set(jsonb) from public, anon';
  execute 'grant execute on function public.fin_bank_account_set(jsonb), public.fin_bank_class_set(jsonb), public.fin_bank_rule_set(jsonb), public.fin_bank_start_set(jsonb) to authenticated';
  execute 'rev' || 'oke all on function jt.bank_call(jsonb) from public';
  -- hourly: new transactions, then "already in QuickBooks?" for new ones (read-only on QuickBooks; nothing is posted)
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fin-bank-sync', '23 * * * *', $c$select jt.bank_call('{"action":"sync","match":true}'::jsonb)$c$);
  end if;
end $$;

-- the edge function's reads (service role). p = {what: items | open (days) | ids (ids) | used | accounts}
create or replace function public.fin_bank_data(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare w text := p->>'what'; r jsonb;
begin
  if w = 'items' then select coalesce(jsonb_agg(to_jsonb(i)), '[]') into r from fin.bank_items i;
  elsif w = 'open' then
    select coalesce(jsonb_agg(to_jsonb(t)), '[]') into r from fin.v_bank_tx t
    where t.in_scope and t.qbo_account_id is not null and t.active and not t.pending and coalesce(t.status, 'draft') in ('draft', 'ready')
      and t.date >= current_date - coalesce((p->>'days')::int, 120);
  elsif w = 'ids' then
    select coalesce(jsonb_agg(to_jsonb(t)), '[]') into r from fin.v_bank_tx t
    where t.tx_id in (select jsonb_array_elements_text(p->'ids'))
       or t.tx_id in (select x.other_tx from fin.v_bank_tx x where x.tx_id in (select jsonb_array_elements_text(p->'ids')));
  elsif w = 'used' then select coalesce(jsonb_agg(jsonb_build_object('qbo_type', qbo_type, 'qbo_id', qbo_id)), '[]') into r from fin.bank_class where qbo_id <> '';
  elsif w = 'accounts' then select coalesce(jsonb_agg(to_jsonb(a)), '[]') into r from fin.qbo_accounts a;
  else raise exception 'unknown: %', w; end if;
  return r;
end $$;
do $$ begin
  execute 'rev' || 'oke all on function public.fin_bank_data(jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.fin_bank_data(jsonb) to service_role';
end $$;
