-- Finance › Amazon payouts (Brian, Oct 10): replaces A2X for Amazon. Each Amazon settlement (the money Amazon pays out
-- every two weeks, per marketplace) is read from Amazon's settlement report, broken down by what each amount is, mapped
-- to QuickBooks accounts the way A2X did it, and — after review on the finance page — posted to QuickBooks as journal
-- entries: one per calendar month the settlement touches (the earlier month's balance carries over through "Amazon
-- Carried Balances", the last one takes the deposit to the bank), plus a cost-of-goods entry (cost of goods sold vs
-- inventory, from the dashboard's product costs). Mexico and Canada post in their own currency at the payout's rate.
--
-- The `amzpay` edge function: sync (daily, and the page's refresh) saves settlements here; post / check talk to
-- QuickBooks.

create table if not exists fin.amz_settlements (
  settlement_id  text primary key,
  report_id      text not null default '',
  market         text not null default '',          -- US | CA | MX
  currency       text not null default 'USD',
  start_at       timestamptz,
  end_at         timestamptz,
  deposit_date   timestamptz,
  total          numeric(14,2) not null default 0,  -- the payout, in the settlement's currency
  rows           integer not null default 0,
  synced_at      timestamptz not null default now(),
  a2x_docs       text[] not null default '{}',      -- A2X journal entries already in QuickBooks for it (not posted again)
  checked_at     timestamptz,
  posted         jsonb not null default '{}'::jsonb, -- {doc: {id, at, by}} our journal entries in QuickBooks
  note           text not null default ''
);

-- amounts by month posted (part), kind of transaction and what the amount is
create table if not exists fin.amz_settlement_sums (
  settlement_id      text not null,
  part               date not null,                 -- first of the month the amounts were posted in
  transaction_type   text not null default '',
  amount_type        text not null default '',
  amount_description text not null default '',
  marketplace        text not null default '',
  fulfillment        text not null default '',      -- AFN | MFN | ''
  amount             numeric(14,2) not null default 0,
  n                  integer not null default 0,
  primary key (settlement_id, part, transaction_type, amount_type, amount_description, marketplace, fulfillment)
);

-- units sold (Order · ItemPrice · Principal rows) by part, fulfillment and SKU: the cost-of-goods entry
create table if not exists fin.amz_settlement_units (
  settlement_id text not null,
  part          date not null,
  fulfillment   text not null default '',
  sku           text not null,
  qty           integer not null default 0,
  primary key (settlement_id, part, fulfillment, sku)
);

-- Amazon's payout groups (Finances API financial event groups): the USD a Mexico / Canada payout came to, and the
-- settlement still open
create table if not exists fin.amz_event_groups (
  group_id       text primary key,
  status         text not null default '',          -- Open | Closed
  transfer       text not null default '',          -- Succeeded | Processing | …
  start_at       timestamptz,
  end_at         timestamptz,
  transfer_at    timestamptz,
  currency       text not null default '',
  original       numeric(14,2),
  converted      numeric(14,2),                     -- in USD
  account_tail   text not null default '',
  synced_at      timestamptz not null default now()
);

-- how each kind of amount maps to a QuickBooks account (first match by priority; '' matches anything). review = a
-- catch-all: posting is allowed, the page flags it.
create table if not exists fin.amz_map (
  id                 bigint generated always as identity primary key,
  priority           integer not null default 100,
  transaction_type   text not null default '',      -- regex (case-insensitive) or ''
  amount_type        text not null default '',
  amount_description text not null default '',
  text_match         text not null default '',      -- regex against "transaction type / amount type / description" together
  account            text not null,                 -- QuickBooks account, full name (Parent:Child)
  review             boolean not null default false,
  note               text not null default '',
  updated_at         timestamptz not null default now(),
  updated_by         text not null default 'default'
);

alter table fin.amz_map add column if not exists text_match text not null default '';

-- QuickBooks chart of accounts (for the mapping's account picker and posting)
create table if not exists fin.qbo_coa (
  id        text primary key,
  name      text not null,                          -- full name
  type      text not null default '',
  active    boolean not null default true,
  currency  text not null default 'USD',
  synced_at timestamptz not null default now()
);

insert into fin.settings (key, value) values ('amz_post', jsonb_build_object(
  'bank', 'BofA (0140)', 'carried', 'Amazon Carried Balances', 'cogs', 'Cost of goods sold', 'inventory', 'Inventory',
  'prefix', 'SSP', 'start', '2026-09-23'))
on conflict (key) do nothing;

-- default mapping, as A2X posted Just Tennis's settlements (2025–2026)
do $$ begin
  if not exists (select 1 from fin.amz_map) then
    insert into fin.amz_map (priority, transaction_type, amount_type, amount_description, account, review, note, text_match) values
      (10, '', '', '^(Previous Reserve Amount Balance|Current Reserve Amount)$', 'Amazon Reserved Balances', false, 'reserve held back by Amazon', ''),
      (11, '', '', '^Payable to Amazon$', 'Amazon Pending Balances', false, 'negative balance carried from the last payout (as A2X)', ''),
      (12, '', '', '^(Cost of Advertising|TransactionTotalAmount)$', 'Advertising & marketing:Amazon Advertising', false, 'ads paid from the payout', ''),
      (14, '^Cost of Advertising', '', '', 'Advertising & marketing:Amazon Advertising', false, '', ''),
      (20, '', '^(ItemWithheldTax|ItemTax)$', '', 'Amazon Sales Tax Collected', false, 'marketplace facilitator tax', ''),
      (22, '', '^(ItemPrice|ItemFees|Promotion)$', '(^Tax$|Tax$|^MarketplaceFacilitator|^LowValueGoods)', 'Amazon Sales Tax Collected', false, 'sales tax', ''),
      (30, '', '^Promotion$', '', 'Amazon Sales:Amazon Promotions', false, '', ''),
      (40, '^Refund', '^ItemPrice$', '^Principal$', 'Amazon Sales:Amazon Refunds', false, '', ''),
      (42, '', '^ItemPrice$', '^RestockingFee$', 'Amazon Seller Fees and Charges', false, '', ''),
      (44, '', '^ItemPrice$', '^(Shipping|GiftWrap|ReturnShipping)$', 'Amazon Sales:Amazon Shipping', false, '', ''),
      (46, '', '^ItemPrice$', '', 'Amazon Sales', false, 'item price', ''),
      (50, '', '^ItemFees?$', '^(FBAPerUnitFulfillmentFee|FBAPerOrderFulfillmentFee|FBAWeightBasedFee)$', 'Amazon FBA Fees', false, '', ''),
      (52, '', '^ItemFees?$', '^(ShippingChargeback|ShippingHB|GiftwrapChargeback)$', 'Amazon Shipping Fees', false, '', ''),
      (54, '', '^ItemFees?$', '', 'Amazon Seller Fees and Charges', false, 'commission, closing fees', ''),
      (60, '', '', '(WAREHOUSE_|REVERSAL_REIMBURSEMENT|COMPENSATED_CLAWBACK|FREE_REPLACEMENT|CS_ERROR|MISSING_FROM_INBOUND|INCORRECT_FEES|CUSTOMER_RETURN|Reimbursement)', 'Amazon Sales:Amazon Reimbursement', false, 'FBA reimbursements', ''),
      (62, 'Reimbursement', '', '', 'Amazon Sales:Amazon Reimbursement', false, '', ''),
      (69, '', '', '', 'Amazon Seller Fees and Charges', false, 'customer returns fees (as A2X)', 'Customer Returns Fee'),
      (70, '', '', '', 'Amazon Seller Fees and Charges', false, 'removal order return fees (as A2X)', 'Removal Order: Return'),
      (71, '', '', '', 'Amazon Seller Fees and Charges', false, 'inbound transportation adjustments (as A2X)', 'Inbound Transportation Fee - Adjustment'),
      (72, '', '', '', 'Amazon Seller Fees and Charges', false, 'Buy Shipping labels (as A2X)', '(Shipping label|Postage)'),
      (73, '', '', '', 'Amazon FBA Fees', false, 'FBA / AWD fees: storage, inbound, placement', '(Storage|Inbound|Placement|AWD|Fulfil|FBA|Disposal|Processing|Transportation|Prep)'),
      (76, '', '', '', 'Amazon Seller Fees and Charges', false, 'subscription, adjustments', '(Subscription|BuyerRecharge|Adjustment)'),
      (999, '', '', '', 'Amazon Seller Fees and Charges', true, 'not recognised — check', '');
  end if;
end $$;

create or replace function fin.amz_account(tt text, at text, ad text) returns table (account text, review boolean, rule_id bigint)
language sql stable set search_path = '' as $$
  select m.account, m.review, m.id from fin.amz_map m
  where (m.transaction_type = '' or coalesce(tt, '') ~* m.transaction_type)
    and (m.amount_type = '' or coalesce(at, '') ~* m.amount_type)
    and (m.amount_description = '' or coalesce(ad, '') ~* m.amount_description)
    and (m.text_match = '' or (coalesce(tt, '') || ' / ' || coalesce(at, '') || ' / ' || coalesce(ad, '')) ~* m.text_match)
  order by m.priority, m.id limit 1;
$$;

-- p = {settlement: {...}, sums: [...], units: [...]} -> saved rows. A settlement's sums and units are replaced as a whole
-- (re-sent reports overwrite: old rows not in this pass are zeroed).
create or replace function public.fin_amz_settlement_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare s jsonb := p->'settlement'; sid text := s->>'id'; n int := 0; k int;
begin
  if coalesce(sid, '') = '' then raise exception 'settlement id missing'; end if;
  insert into fin.amz_settlements (settlement_id, report_id, market, currency, start_at, end_at, deposit_date, total, rows, synced_at)
  values (sid, coalesce(s->>'report_id', ''), coalesce(s->>'market', ''), coalesce(s->>'currency', 'USD'), (s->>'start')::timestamptz,
          (s->>'end')::timestamptz, (s->>'deposit')::timestamptz, coalesce((s->>'total')::numeric, 0), coalesce((s->>'rows')::int, 0), now())
  on conflict (settlement_id) do update set report_id = excluded.report_id, market = excluded.market, currency = excluded.currency,
    start_at = excluded.start_at, end_at = excluded.end_at, deposit_date = excluded.deposit_date, total = excluded.total, rows = excluded.rows, synced_at = now();
  update fin.amz_settlement_sums set amount = 0, n = 0 where settlement_id = sid;
  insert into fin.amz_settlement_sums (settlement_id, part, transaction_type, amount_type, amount_description, marketplace, fulfillment, amount, n)
  select sid, (x->>'part')::date, coalesce(x->>'tt', ''), coalesce(x->>'at', ''), coalesce(x->>'ad', ''), coalesce(x->>'mk', ''), coalesce(x->>'ful', ''),
         coalesce((x->>'amount')::numeric, 0), coalesce((x->>'n')::int, 0)
  from jsonb_array_elements(coalesce(p->'sums', '[]'::jsonb)) x
  on conflict (settlement_id, part, transaction_type, amount_type, amount_description, marketplace, fulfillment) do update set amount = excluded.amount, n = excluded.n;
  get diagnostics k = row_count; n := n + k;
  update fin.amz_settlement_units set qty = 0 where settlement_id = sid;
  insert into fin.amz_settlement_units (settlement_id, part, fulfillment, sku, qty)
  select sid, (x->>'part')::date, coalesce(x->>'ful', ''), x->>'sku', coalesce((x->>'qty')::int, 0)
  from jsonb_array_elements(coalesce(p->'units', '[]'::jsonb)) x where coalesce(x->>'sku', '') <> ''
  on conflict (settlement_id, part, fulfillment, sku) do update set qty = excluded.qty;
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;

create or replace function public.fin_amz_groups_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into fin.amz_event_groups (group_id, status, transfer, start_at, end_at, transfer_at, currency, original, converted, account_tail, synced_at)
  select x->>'id', coalesce(x->>'status', ''), coalesce(x->>'transfer', ''), (x->>'start')::timestamptz, (x->>'end')::timestamptz,
         (x->>'transfer_at')::timestamptz, coalesce(x->>'currency', ''), (x->>'original')::numeric, (x->>'converted')::numeric, coalesce(x->>'tail', ''), now()
  from jsonb_array_elements(coalesce(p->'groups', '[]'::jsonb)) x
  on conflict (group_id) do update set status = excluded.status, transfer = excluded.transfer, start_at = excluded.start_at, end_at = excluded.end_at,
    transfer_at = excluded.transfer_at, currency = excluded.currency, original = excluded.original, converted = excluded.converted,
    account_tail = excluded.account_tail, synced_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.fin_qbo_coa_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  insert into fin.qbo_coa (id, name, type, active, currency, synced_at)
  select x->>'id', x->>'name', coalesce(x->>'type', ''), coalesce((x->>'active')::boolean, true), coalesce(x->>'currency', 'USD'), now()
  from jsonb_array_elements(coalesce(p->'accounts', '[]'::jsonb)) x
  on conflict (id) do update set name = excluded.name, type = excluded.type, active = excluded.active, currency = excluded.currency, synced_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- the payout group a settlement belongs to (same currency, started within an hour) -> the USD rate
create or replace view fin.v_amz_settlements as
select s.*, g.group_id, g.converted as converted_usd, g.transfer as transfer_status, g.transfer_at,
       case when s.currency = 'USD' then 1
            when g.converted is not null and g.original <> 0 then round(g.converted / g.original, 6)
            else (select (value->>s.currency)::numeric from jt.settings where key = 'amazon_fx') end as fx,
       (select coalesce(sum(u.qty), 0) from fin.amz_settlement_units u where u.settlement_id = s.settlement_id) as units
from fin.amz_settlements s
left join lateral (select * from fin.amz_event_groups g where g.currency = s.currency and abs(extract(epoch from g.start_at - s.start_at)) < 3600
                   order by abs(extract(epoch from g.start_at - s.start_at)) limit 1) g on true;

-- The journal entries for one settlement: {settlement, parts: [{doc, date, kind: main|cogs, currency, fx, lines: [{account,
-- amount (+ debit, − credit), description, review}]}], problems: [...]}. The page shows it; amzpay posts exactly this.
create or replace function fin.amz_entry(sid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  s record; cfg jsonb := coalesce((select value from fin.settings where key = 'amz_post'), '{}'::jsonb);
  parts date[]; pt date; i int; out jsonb := '[]'::jsonb; probs jsonb := '[]'::jsonb; lines jsonb; carry numeric := 0; net numeric;
  doc text; dt date; ndays text; pfx text := coalesce(cfg->>'prefix', 'SSP'); ful record; c jsonb; cogs_lines jsonb; miss jsonb;
  fmt text := 'DDMon';
begin
  select * into s from fin.v_amz_settlements where settlement_id = sid;
  if not found then return null; end if;
  select array_agg(distinct x.part order by x.part) into parts from fin.amz_settlement_sums x where x.settlement_id = sid and x.amount <> 0;
  if parts is null then parts := array[date_trunc('month', s.start_at)::date]; end if;
  for i in 1 .. array_length(parts, 1) loop
    pt := parts[i];
    -- dated and numbered as A2X did: Pacific days, {part start}-{settlement end}
    dt := greatest(pt, (s.start_at at time zone 'America/Los_Angeles')::date);
    ndays := to_char(dt, fmt) || '-' || to_char((s.end_at at time zone 'America/Los_Angeles')::date, fmt);
    doc := left(pfx || s.market || '-' || ndays || '-' || right(sid, 3), 21);
    -- amounts -> accounts, grouped by account and description
    select coalesce(jsonb_agg(jsonb_build_object('account', l.account, 'amount', l.amt, 'description', l.descr, 'review', l.review) order by l.account, l.descr), '[]'::jsonb),
           coalesce(sum(-l.amt), 0)
      into lines, net
    from (select a.account, bool_or(a.review) as review, -sum(x.amount) as amt,
                 left(x.amount_description || case when x.marketplace <> '' then ' - ' || x.marketplace else '' end
                   || case when x.amount_type in ('ItemPrice', 'Promotion') then case x.fulfillment when 'AFN' then ' FBA' when 'MFN' then ' Merchant' else '' end else '' end
                   || ' (' || x.transaction_type || case when x.amount_type <> '' and x.amount_type <> x.transaction_type then ' ' || regexp_replace(x.amount_type, ' for ASIN: .*$', '') else '' end || ')', 100) as descr
          from fin.amz_settlement_sums x cross join lateral fin.amz_account(x.transaction_type, x.amount_type, x.amount_description) a
          where x.settlement_id = sid and x.part = pt and x.amount <> 0
          group by 1, 4 having round(sum(x.amount), 2) <> 0) l;
    if carry <> 0 then
      lines := jsonb_build_array(jsonb_build_object('account', cfg->>'carried', 'amount', -carry, 'description', 'Balance carried forward from ' || to_char(parts[i - 1], 'Mon YYYY'))) || lines;
    end if;
    if i < array_length(parts, 1) then
      carry := carry + net;
      lines := lines || jsonb_build_array(jsonb_build_object('account', cfg->>'carried', 'amount', carry, 'description', 'Balance carried forward to ' || to_char(parts[i + 1], 'Mon YYYY')));
    else
      lines := lines || jsonb_build_array(jsonb_build_object('account', cfg->>'bank', 'amount', s.total,
        'description', 'Amazon ' || s.market || ' payout ' || coalesce(to_char(s.deposit_date at time zone 'America/Los_Angeles', 'YYYY-MM-DD'), '') || ' (settlement ' || sid || ')'));
      if round(carry + net, 2) <> round(s.total, 2) then
        probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', format('The amounts add to %s but the payout is %s.', round(carry + net, 2), s.total)));
      end if;
    end if;
    out := out || jsonb_build_array(jsonb_build_object('doc', doc, 'date', dt, 'kind', 'main', 'part', pt, 'currency', s.currency, 'fx', s.fx, 'lines', lines,
      'posted', s.posted->doc));
    -- cost of goods for the units sold in this part (USD)
    cogs_lines := '[]'::jsonb;
    for ful in select u.fulfillment, round(sum(u.qty * c2.cost), 2) as cost, sum(u.qty) as qty
               from fin.amz_settlement_units u join jt.mv_amz_sku_cost c2 on c2.sku = u.sku
               where u.settlement_id = sid and u.part = pt and u.qty <> 0 and c2.cost is not null group by 1 order by 1 loop
      if ful.cost <> 0 then
        cogs_lines := cogs_lines || jsonb_build_array(
          jsonb_build_object('account', cfg->>'cogs', 'amount', ful.cost, 'description', 'Cost of goods sold (sales) - ' || case ful.fulfillment when 'MFN' then 'Merchant fulfilled (MFN)' else 'Fulfillment by Amazon (FBA)' end || ' · ' || ful.qty || ' units'),
          jsonb_build_object('account', cfg->>'inventory', 'amount', -ful.cost, 'description', 'Inventory deduction (sales) - ' || case ful.fulfillment when 'MFN' then 'Merchant fulfilled (MFN)' else 'Fulfillment by Amazon (FBA)' end));
      end if;
    end loop;
    if jsonb_array_length(cogs_lines) > 0 then
      doc := left(pfx || s.market || '-' || ndays || 'C' || right(sid, 3), 21);
      out := out || jsonb_build_array(jsonb_build_object('doc', doc, 'date', dt, 'kind', 'cogs', 'part', pt, 'currency', 'USD', 'fx', 1, 'lines', cogs_lines, 'posted', s.posted->doc));
    end if;
  end loop;
  select coalesce(jsonb_agg(jsonb_build_object('sku', m.sku, 'qty', m.qty)), '[]'::jsonb) into miss
  from (select u.sku, sum(u.qty) as qty from fin.amz_settlement_units u left join jt.mv_amz_sku_cost c2 on c2.sku = u.sku
        where u.settlement_id = sid and u.qty <> 0 and c2.cost is null group by 1 order by 2 desc) m;
  if jsonb_array_length(miss) > 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'cost', 'message', jsonb_array_length(miss) || ' SKU(s) have no cost, so their units are left out of cost of goods.', 'skus', miss));
  end if;
  if s.currency <> 'USD' and s.fx is null then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'fx', 'message', 'No exchange rate for ' || s.currency || ' yet.'));
  end if;
  return jsonb_build_object('settlement', to_jsonb(s), 'parts', out, 'problems', probs);
end $$;
revoke all on function fin.amz_entry(text) from public;

-- for the finance page (finance list) and amzpay (service role)
create or replace function public.fin_amz_entry(sid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (fin.is_user() or coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return fin.amz_entry(sid);
end $$;

-- p = {settlement_id, doc, id?, a2x?: [...docs], checked?: true, by} : what QuickBooks has for it
create or replace function public.fin_amz_posted(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update fin.amz_settlements set
    posted = case when p ? 'doc' and coalesce(p->>'id', '') <> '' then posted || jsonb_build_object(p->>'doc', jsonb_build_object('id', p->>'id', 'at', now(), 'by', coalesce(p->>'by', ''), 'how', coalesce(p->>'how', 'created')))
                  when p ? 'doc' and p ? 'id' and coalesce(p->>'id', '') = '' then posted - (p->>'doc') else posted end,
    a2x_docs = case when p ? 'a2x' then array(select jsonb_array_elements_text(p->'a2x')) else a2x_docs end,
    checked_at = case when coalesce((p->>'checked')::boolean, false) then now() else checked_at end
  where settlement_id = p->>'settlement_id';
  return found;
end $$;

-- mapping changes from the page. p = {id?, priority?, transaction_type?, amount_type?, amount_description?, account, off?}
create or replace function public.fin_amz_map_set(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare rid bigint := nullif(p->>'id', '')::bigint; who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '');
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce((p->>'off')::boolean, false) then
    update fin.amz_map set account = account, priority = priority + 100000, updated_by = who, updated_at = now(), note = '[off] ' || note where id = rid;
    return rid;
  end if;
  if coalesce(p->>'account', '') = '' then raise exception 'account is required'; end if;
  if rid is null then   -- the same rule set again: change its account
    select id into rid from fin.amz_map where priority = coalesce((p->>'priority')::int, 5) and transaction_type = coalesce(p->>'transaction_type', '')
      and amount_type = coalesce(p->>'amount_type', '') and amount_description = coalesce(p->>'amount_description', '') and text_match = '' order by id limit 1;
  end if;
  if rid is null then
    insert into fin.amz_map (priority, transaction_type, amount_type, amount_description, account, review, note, updated_by)
    values (coalesce((p->>'priority')::int, 5), coalesce(p->>'transaction_type', ''), coalesce(p->>'amount_type', ''), coalesce(p->>'amount_description', ''),
            p->>'account', false, coalesce(p->>'note', ''), who) returning id into rid;
  else
    update fin.amz_map set account = p->>'account', review = false, updated_by = who, updated_at = now() where id = rid;
  end if;
  return rid;
end $$;

revoke all on function public.fin_amz_settlement_save(jsonb), public.fin_amz_groups_save(jsonb), public.fin_qbo_coa_save(jsonb),
  public.fin_amz_entry(text), public.fin_amz_posted(jsonb), public.fin_amz_map_set(jsonb) from public;
grant select on fin.amz_settlements, fin.amz_settlement_sums, fin.amz_settlement_units, fin.amz_event_groups, fin.amz_map, fin.qbo_coa, fin.v_amz_settlements to fin_reader;
grant execute on function fin.amz_account(text, text, text) to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_amz_settlement_save(jsonb), public.fin_amz_groups_save(jsonb), public.fin_qbo_coa_save(jsonb),
      public.fin_amz_entry(text), public.fin_amz_posted(jsonb), public.fin_amz_map_set(jsonb) from anon;
    grant execute on function public.fin_amz_entry(text), public.fin_amz_map_set(jsonb) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_amz_settlement_save(jsonb), public.fin_amz_groups_save(jsonb), public.fin_qbo_coa_save(jsonb),
      public.fin_amz_entry(text), public.fin_amz_posted(jsonb) to service_role;
  end if;
end $$;

-- helpers for amzpay: report ids already saved; settlements not yet fully in QuickBooks; a settlement's report
create or replace function public.fin_amz_report_ids() returns text[]
language sql stable security definer set search_path = '' as $$ select coalesce(array_agg(report_id), '{}') from fin.amz_settlements where report_id <> '' $$;
create or replace function public.fin_amz_open_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(settlement_id order by start_at), '{}') from fin.amz_settlements
  where cardinality(a2x_docs) = 0 and posted = '{}'::jsonb and end_at > now() - interval '120 days' $$;
create or replace function public.fin_amz_report_of(sid text) returns text
language sql stable security definer set search_path = '' as $$ select report_id from fin.amz_settlements where settlement_id = sid $$;
revoke all on function public.fin_amz_report_ids(), public.fin_amz_open_ids(), public.fin_amz_report_of(text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_amz_report_ids(), public.fin_amz_open_ids(), public.fin_amz_report_of(text) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_amz_report_ids(), public.fin_amz_open_ids(), public.fin_amz_report_of(text) to service_role;
  end if;
end $$;

-- calling amzpay from SQL (pg_cron): same key as the qbo function
create or replace function jt.amzpay_call(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/amzpay', body := p, timeout_milliseconds := 120000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $$;
revoke all on function jt.amzpay_call(jsonb) from public;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('fin-amz-settlements', '40 14 * * *', $c$select jt.amzpay_call('{"action":"sync"}'::jsonb)$c$);
  end if;
end $$;
