-- Finance › Shopify payouts › other payments (Brian, Oct 11): money that doesn't come through Shopify Payments — manual
-- / wholesale orders (check, ACH, wire), cash at the store, PayPal, gift cards. The way it works:
--   1. The order is marked paid in Shopify (a payment on the manual / cash / paypal … gateway).
--   2. The bank deposit is categorized in QuickBooks to that gateway's clearing account (e.g. Manual Clearing Account -
--      Shopify).
-- Seller Sage reads both: one journal entry per week books the Shopify payments as sales (clearing account debit;
-- sales, shipping, sales tax credits — split like each order, as for payouts) plus cost of goods; the deposits credit the
-- clearing account. What's left in a clearing account is paid in Shopify but not deposited yet (or the other way round),
-- and orders still owing money are listed with what they owe.

-- every successful Shopify payment that isn't Shopify Payments (sync job shopify-order-payments)
create table if not exists jt.shopify_order_payments (
  store        text not null,
  id           bigint not null,                 -- OrderTransaction id
  order_id     bigint not null,
  kind         text not null,                   -- SALE | CAPTURE | REFUND
  gateway      text not null default '',
  amount       numeric not null default 0,      -- positive; REFUND is money back to the customer
  processed_at timestamptz not null,
  test         boolean not null default false,
  synced_at    timestamptz not null default now(),
  primary key (store, id)
);
create index if not exists shopify_order_payments_order on jt.shopify_order_payments (store, order_id);

-- what each order still owes (Shopify's total outstanding), from the same sync
create table if not exists jt.shopify_order_due (
  store            text not null,
  order_id         bigint not null,
  name             text not null default '',
  created_at       timestamptz,
  source_name      text not null default '',
  financial_status text not null default '',
  total            numeric not null default 0,
  outstanding      numeric not null default 0,
  gateways         text not null default '',
  cancelled        boolean not null default false,
  test             boolean not null default false,
  synced_at        timestamptz not null default now(),
  primary key (store, order_id)
);

-- deposits (and other QuickBooks transactions) that hit a clearing account, read by amzpay shop_clearing
create table if not exists fin.qbo_clearing (
  txn_type   text not null,                     -- Deposit | JournalEntry | …
  txn_id     text not null,
  line_id    text not null,
  account    text not null,
  txn_date   date not null,
  amount     numeric not null,                  -- + = debit (into the clearing account), − = credit (a deposit clearing it)
  doc        text not null default '',
  memo       text not null default '',
  synced_at  timestamptz not null default now(),
  primary key (txn_type, txn_id, line_id)
);
create table if not exists fin.qbo_clearing_balances (
  account    text primary key,
  balance    numeric not null,
  synced_at  timestamptz not null default now()
);

-- posted weekly entries: {doc: {id, at, by, how}}
create table if not exists fin.shop_pay_weeks (
  week_end   date primary key,                  -- the Sunday the week ends (Pacific)
  posted     jsonb not null default '{}'::jsonb,
  checked_at timestamptz
);

-- which clearing account each gateway's payments go to (as A2X had them)
update fin.settings set value = value || jsonb_build_object('gateways', jsonb_build_object(
    'manual', 'Manual Clearing Account - Shopify', 'cash', 'Cash:Cash Clearing - Shopify', 'paypal', 'Paypal Clearing Account',
    'shop_cash', 'Manual Clearing Account - Shopify', 'gift_card', 'Shopify Gift Card Liabilities'),
  'gateway_other', 'Shopify Clearing Account')
where key = 'shop_post' and not value ? 'gateways';

create or replace function fin.shop_gateway_account(gw text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select value->'gateways'->>lower(gw) from fin.settings where key = 'shop_post'),
                  (select value->>'gateway_other' from fin.settings where key = 'shop_post'), 'Shopify Clearing Account')
$$;

-- each payment split like its order (as fin.v_shop_tx does for payouts); payments for orders A2X already booked
-- (placed on or before a2x_until) clear Shopify Pending Balances instead
create or replace view fin.v_shop_other_tx as
with u as (select (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post') as until),
t as (
  select p.*, case when p.kind = 'REFUND' then -p.amount else p.amount end as signed,
         (p.processed_at at time zone 'America/Los_Angeles')::date as day,
         o.total as o_total, o.tax as o_tax, o.shipping as o_shipping, o.name as o_name, o.order_day as o_day,
         fin.shop_gateway_account(p.gateway) as account,
         (select value->'gateways' ? lower(p.gateway) from fin.settings where key = 'shop_post') as known
  from jt.shopify_order_payments p left join jt.shopify_orders o on o.order_id = p.order_id
  where p.store = 'justtennis' and not p.test and lower(p.gateway) <> 'shopify_payments'),
c as (
  select t.*, (t.day - extract(isodow from t.day)::int + 7) as week_end,
         coalesce(case when t.kind <> 'REFUND' then t.o_day > u.until else t.day > u.until end, true) as ours,
         t.day > coalesce(u.until, '1900-01-01') as after_switch
  from t cross join u)
select c.store, c.id, c.order_id, coalesce(c.o_name, '') as order_name, c.kind, c.gateway, c.account, coalesce(c.known, false) as known,
       c.processed_at, c.day, c.week_end, c.after_switch, not c.ours as a2x, c.signed as amount,
       case when c.ours and c.o_total > 0 then round(c.signed * least(1, greatest(0, c.o_tax / c.o_total)), 2) else 0 end as tax_part,
       case when c.ours and c.kind <> 'REFUND' and c.o_total > 0 then round(c.signed * least(1, greatest(0, c.o_shipping / c.o_total)), 2) else 0 end as ship_part,
       case when c.ours and c.kind <> 'REFUND' then c.signed
              - case when c.o_total > 0 then round(c.signed * least(1, greatest(0, c.o_tax / c.o_total)), 2) else 0 end
              - case when c.o_total > 0 then round(c.signed * least(1, greatest(0, c.o_shipping / c.o_total)), 2) else 0 end else 0 end as sales_part,
       case when c.ours and c.kind = 'REFUND' then c.signed
              - case when c.o_total > 0 then round(c.signed * least(1, greatest(0, c.o_tax / c.o_total)), 2) else 0 end else 0 end as refund_part,
       case when not c.ours then c.signed else 0 end as pending_part,
       case when c.ours and c.kind <> 'REFUND' then
         round(coalesce(k.cogs, 0) * case when c.o_total > 0 then least(1, greatest(0, c.signed / c.o_total)) else 1 end, 2) else 0 end as cogs,
       (c.ours and c.kind <> 'REFUND' and coalesce(k.no_cost, 0) > 0) as missing_cost
from c
left join lateral (select sum(a.cogs + a.cost_added) as cogs, sum(a.net_no_cost_adj) as no_cost from jt.v_sales_adjusted a where a.order_id = c.order_id) k on c.ours and c.kind <> 'REFUND';

-- one row per week since the switch
create or replace view fin.v_shop_pay_weeks as
with x as (select * from fin.v_shop_other_tx where after_switch),
g as (select week_end, jsonb_object_agg(gateway, amt) as by_gateway from (select week_end, gateway, sum(amount) as amt from x group by 1, 2) q group by 1)
select x.week_end, x.week_end - 6 as week_start, coalesce(w.posted, '{}'::jsonb) as posted, w.checked_at,
       x.week_end < (now() at time zone 'America/Los_Angeles')::date as complete,
       count(*) as payments, count(distinct x.order_id) as orders,
       sum(x.amount) as amount, sum(x.sales_part) as sales, sum(x.ship_part) as shipping, sum(x.tax_part) as tax,
       sum(x.refund_part) as refunds, sum(x.pending_part) as a2x_pending, sum(x.cogs) as cogs,
       count(distinct x.order_id) filter (where x.missing_cost) as orders_missing_cost,
       count(*) filter (where not x.known) as unknown_gateway, max(g.by_gateway::text)::jsonb as by_gateway
from x
left join fin.shop_pay_weeks w on w.week_end = x.week_end
left join g on g.week_end = x.week_end
group by x.week_end, w.posted, w.checked_at;

-- the week's journal entry: clearing accounts debited with what was paid; sales / shipping / tax credited (refunds the
-- other way); payments for orders A2X booked clear Shopify Pending Balances. Plus cost of goods.
create or replace function fin.shop_pay_entry(we date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  w record; cfg jsonb := coalesce((select value from fin.settings where key = 'shop_post'), '{}'::jsonb);
  x record; lines jsonb; out jsonb := '[]'::jsonb; probs jsonb := '[]'::jsonb; doc text; cdoc text; clr jsonb;
begin
  select * into w from fin.v_shop_pay_weeks where week_end = we;
  if not found then return null; end if;
  doc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(we, 'DDMon') || '-PAY';
  cdoc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(we, 'DDMon') || 'CPAY';
  select coalesce(jsonb_agg(jsonb_build_object('account', account, 'amount', amt, 'review', not known,
           'description', format('Paid in Shopify · %s · %s order%s', gws, n, case when n = 1 then '' else 's' end)) order by account), '[]'::jsonb)
    into clr
  from (select account, bool_and(known) as known, round(sum(amount), 2) as amt, string_agg(distinct gateway, ', ') as gws, count(distinct order_id) as n
        from fin.v_shop_other_tx where after_switch and week_end = we group by account) a where amt <> 0;
  select count(distinct order_id) filter (where kind <> 'REFUND' and not a2x) as orders, count(*) filter (where kind = 'REFUND' and not a2x) as refunds,
         count(*) filter (where a2x) as pending_n,
         coalesce(sum(sales_part), 0) as sales, coalesce(sum(ship_part), 0) as ship,
         coalesce(sum(tax_part) filter (where kind <> 'REFUND'), 0) as tax_in, coalesce(sum(tax_part) filter (where kind = 'REFUND'), 0) as tax_out,
         coalesce(sum(refund_part), 0) as refund, coalesce(sum(pending_part), 0) as pending, coalesce(sum(cogs), 0) as cogs
    into x from fin.v_shop_other_tx where after_switch and week_end = we;
  lines := clr || jsonb_build_array(
    jsonb_build_object('account', cfg->>'sales', 'amount', -x.sales, 'description', format('Sales after discounts · %s order%s', x.orders, case when x.orders = 1 then '' else 's' end)),
    jsonb_build_object('account', cfg->>'shipping', 'amount', -x.ship, 'description', 'Shipping charged'),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.tax_in, 'description', 'Sales tax collected'),
    jsonb_build_object('account', cfg->>'refunds', 'amount', -x.refund, 'description', format('Refunds · %s', x.refunds)),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.tax_out, 'description', 'Sales tax refunded'),
    jsonb_build_object('account', coalesce(cfg->>'pending', 'Shopify Pending Balances'), 'amount', -x.pending,
      'description', format('Paid now for orders A2X already booked (through %s) · %s', to_char((cfg->>'a2x_until')::date, 'Mon DD'), x.pending_n)));
  select coalesce(jsonb_agg(l), '[]'::jsonb) into lines from jsonb_array_elements(lines) l where round((l->>'amount')::numeric, 2) <> 0;
  out := jsonb_build_array(jsonb_build_object('doc', doc, 'date', we, 'kind', 'main', 'currency', 'USD', 'fx', 1, 'lines', lines, 'posted', w.posted->doc));
  if round(x.cogs, 2) <> 0 then
    out := out || jsonb_build_array(jsonb_build_object('doc', cdoc, 'date', we, 'kind', 'cogs', 'currency', 'USD', 'fx', 1, 'posted', w.posted->cdoc,
      'lines', jsonb_build_array(
        jsonb_build_object('account', cfg->>'cogs', 'amount', round(x.cogs, 2), 'description', format('Cost of goods sold · %s Shopify order%s (manual, cash, PayPal …)', x.orders, case when x.orders = 1 then '' else 's' end)),
        jsonb_build_object('account', cfg->>'inventory', 'amount', -round(x.cogs, 2), 'description', 'Inventory deduction (Shopify sales)'))));
  end if;
  if not w.complete then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', 'This week isn''t over yet — post it after ' || to_char(we, 'Mon DD') || '.'));
  end if;
  if w.unknown_gateway > 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'other', 'message', 'Some payments are on a gateway without its own clearing account — they''re on ' || coalesce(cfg->>'gateway_other', 'Shopify Clearing Account') || '; check them.'));
  end if;
  if w.orders_missing_cost > 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'cost', 'message', w.orders_missing_cost || ' order(s) have items with no cost, so those items are left out of cost of goods.'));
  end if;
  return jsonb_build_object('week', to_jsonb(w), 'parts', out, 'problems', probs);
end $$;
revoke all on function fin.shop_pay_entry(date) from public;

create or replace function public.fin_shop_pay_entry(we date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (fin.is_user() or coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return fin.shop_pay_entry(we);
end $$;

-- p = {week_end, doc?, id?, how?, by?, checked?}
create or replace function public.fin_shop_week_posted(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into fin.shop_pay_weeks (week_end) values ((p->>'week_end')::date) on conflict do nothing;
  update fin.shop_pay_weeks set
    posted = case when p ? 'doc' and coalesce(p->>'id', '') <> '' then posted || jsonb_build_object(p->>'doc', jsonb_build_object('id', p->>'id', 'at', now(), 'by', coalesce(p->>'by', ''), 'how', coalesce(p->>'how', 'created')))
                  else posted end,
    checked_at = case when coalesce((p->>'checked')::boolean, false) then now() else checked_at end
  where week_end = (p->>'week_end')::date;
  return found;
end $$;

-- p = {from, to, rows: [{txn_type, txn_id, line_id, account, date, amount, doc, memo}], balances: [{account, balance}]}
-- the clearing accounts' QuickBooks lines between from and to are replaced
create or replace function public.fin_qbo_clearing_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  delete from fin.qbo_clearing where txn_date between (p->>'from')::date and (p->>'to')::date;
  insert into fin.qbo_clearing (txn_type, txn_id, line_id, account, txn_date, amount, doc, memo, synced_at)
  select x->>'txn_type', x->>'txn_id', x->>'line_id', x->>'account', (x->>'date')::date, (x->>'amount')::numeric,
         coalesce(x->>'doc', ''), coalesce(x->>'memo', ''), now()
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x
  on conflict (txn_type, txn_id, line_id) do update set account = excluded.account, txn_date = excluded.txn_date, amount = excluded.amount,
    doc = excluded.doc, memo = excluded.memo, synced_at = now();
  get diagnostics n = row_count;
  insert into fin.qbo_clearing_balances (account, balance, synced_at)
  select x->>'account', (x->>'balance')::numeric, now() from jsonb_array_elements(coalesce(p->'balances', '[]'::jsonb)) x
  on conflict (account) do update set balance = excluded.balance, synced_at = now();
  return n;
end $$;

-- the clearing accounts since the switch: what Shopify says was paid (Seller Sage books it) against what QuickBooks
-- shows deposited (other entries and deposits on the account, not Seller Sage's own)
create or replace view fin.v_shop_clearing as
with u as (select (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post') as until),
accts as (select distinct g.value as account from fin.settings st cross join lateral jsonb_each_text(st.value->'gateways') g where st.key = 'shop_post'
          union select st.value->>'gateway_other' from fin.settings st where st.key = 'shop_post'),
paid as (select account, sum(amount) as paid, count(*) as payments, max(day) as last_paid from fin.v_shop_other_tx where after_switch group by 1),
dep as (select c.account, sum(c.amount) as qbo, count(*) as lines, max(c.txn_date) as last_dep
        from fin.qbo_clearing c cross join u where c.txn_date > u.until and c.doc not like 'SSP%' group by 1)
select a.account, coalesce(p.paid, 0) as paid, coalesce(p.payments, 0) as payments, p.last_paid,
       coalesce(d.qbo, 0) as deposited, coalesce(d.lines, 0) as deposits, d.last_dep,
       coalesce(p.paid, 0) + coalesce(d.qbo, 0) as open_balance,
       b.balance as qbo_balance, b.synced_at as qbo_synced_at
from accts a left join paid p using (account) left join dep d using (account) left join fin.qbo_clearing_balances b using (account)
where a.account is not null;

-- orders still owing money
create or replace view fin.v_shop_due as
select d.order_id, d.name, d.created_at, (d.created_at at time zone 'America/Los_Angeles')::date as order_day, d.source_name, d.financial_status,
       d.total, d.outstanding, d.total - d.outstanding as paid, d.gateways,
       (now() at time zone 'America/Los_Angeles')::date - (d.created_at at time zone 'America/Los_Angeles')::date as days_old, d.synced_at
from jt.shopify_order_due d
where d.store = 'justtennis' and d.outstanding > 0 and not d.cancelled and not d.test
  and d.financial_status not in ('AUTHORIZED', 'VOIDED', 'REFUNDED');

revoke all on function public.fin_shop_pay_entry(date), public.fin_shop_week_posted(jsonb), public.fin_qbo_clearing_save(jsonb) from public;
grant select on fin.v_shop_other_tx, fin.v_shop_pay_weeks, fin.v_shop_clearing, fin.v_shop_due, fin.qbo_clearing, fin.qbo_clearing_balances to fin_reader;
grant execute on function fin.shop_pay_entry(date), fin.shop_gateway_account(text) to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_shop_pay_entry(date), public.fin_shop_week_posted(jsonb), public.fin_qbo_clearing_save(jsonb) from anon;
    grant execute on function public.fin_shop_pay_entry(date) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_shop_pay_entry(date), public.fin_shop_week_posted(jsonb), public.fin_qbo_clearing_save(jsonb) to service_role;
  end if;
end $$;

-- the clearing account names (for amzpay shop_clearing)
create or replace function public.fin_shop_clearing_accounts() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct account), '{}') from fin.v_shop_clearing
$$;
revoke all on function public.fin_shop_clearing_accounts() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.fin_shop_clearing_accounts() from anon; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.fin_shop_clearing_accounts() to service_role; end if;
end $$;
