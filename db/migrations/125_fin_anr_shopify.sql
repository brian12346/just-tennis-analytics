-- Finance (Brian, Oct 11): "rename shopify tab to just tennis and then bring in ace n rally". A2X is cancelled. Ace n Rally's
-- Shopify money is handled exactly like Just Tennis's — Shopify Payments payouts, other payments (manual, cash, PayPal …),
-- orders waiting for payment — with its own settings (fin.settings 'shop_post_acenrally'): its payouts go to PLAT BUS
-- CHECKING (3355), its entries are numbered SSPAR-…, and A2X's last Ace n Rally payout entry covered orders through
-- Sep 20, so that's its switch day. The QuickBooks accounts are the same Shopify accounts Just Tennis uses (as A2X had
-- them), so the clearing accounts and the PayPal check cover both stores. Cost of goods for Ace n Rally orders comes from
-- the dashboard's Ace n Rally costs (jt.v_anr_sales_final).

alter table fin.shopify_payouts add column if not exists store text not null default 'justtennis';
create index if not exists shopify_payouts_store on fin.shopify_payouts (store, issued_at);

update fin.settings set value = value || jsonb_build_object('label', 'Just Tennis') where key = 'shop_post' and not value ? 'label';
insert into fin.settings (key, value)
select 'shop_post_acenrally', (value - 'paypal' - 'admin_store') || jsonb_build_object('label', 'Ace n Rally', 'bank', 'PLAT BUS CHECKING (3355) - 3', 'prefix', 'SSPAR',
       'a2x_until', '2026-09-20', 'start', '2026-10-01', 'admin_store', '')
from fin.settings where key = 'shop_post'
on conflict (key) do nothing;

-- a store's settings
create or replace function fin.shop_cfg(st text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select value from fin.settings where key = case when coalesce(st, 'justtennis') = 'justtennis' then 'shop_post' else 'shop_post_' || st end), '{}'::jsonb)
$$;
create or replace function fin.shop_gateway_account(gw text, st text) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(fin.shop_cfg(st)->'gateways'->>lower(gw), fin.shop_cfg(st)->>'gateway_other', 'Shopify Clearing Account')
$$;

-- both stores' orders, the way the entries need them
create or replace view fin.v_shop_orders as
select 'justtennis'::text as store, order_id, name, order_day, total, tax, shipping from jt.shopify_orders
union all
select 'acenrally', order_id, name, order_day, total, tax, shipping from jt.anr_orders;

-- Ace n Rally cost of goods per order (the dashboard's Ace n Rally costs)
create or replace view fin.v_anr_order_cogs as
select order_id, sum(cogs) as cogs, sum(net_no_cost) as no_cost from jt.v_anr_sales_final where order_id <> 0 group by 1;

create or replace view fin.v_shop_tx as
with t as (
  select t.*, o.total as o_total, o.tax as o_tax, o.shipping as o_shipping, o.name as o_name, o.order_day as o_day,
         case when t.type = 'CHARGE' then 'charge' when t.type = 'REFUND' then 'refund' when t.type like 'DISPUTE%' then 'dispute'
              when t.type like 'SHOP_CASH%' then 'shopcash' when t.type like 'TAX_ADJUSTMENT%' then 'taxadj' else 'other' end as kind
  from jt.shopify_payment_tx t left join fin.v_shop_orders o on o.store = t.store and o.order_id = t.order_id
  where not t.test and t.payout_id <> ''),
c as (
  select t.*, coalesce(case when t.kind = 'shopcash' then true when t.kind = 'charge' then t.o_day > u.until else (t.processed_at at time zone 'America/Los_Angeles')::date > u.until end, true) as ours
  from t cross join lateral (select (fin.shop_cfg(t.store)->>'a2x_until')::date as until) u),
s as (
  select c.*,
         case when ours and kind in ('charge', 'refund') and o_total > 0 then round(amount * least(1, greatest(0, o_tax / o_total)), 2) else 0 end as tax_part,
         case when ours and kind = 'charge' and o_total > 0 then round(amount * least(1, greatest(0, o_shipping / o_total)), 2) else 0 end as ship_part
  from c)
select s.store, s.id, s.payout_id, s.type, s.kind, s.processed_at, s.order_id, coalesce(nullif(s.order_name, ''), s.o_name, '') as order_name,
       s.amount, s.fee, s.net, s.tax_part, s.ship_part,
       case when s.ours and s.kind = 'charge' then s.amount - s.tax_part - s.ship_part else 0 end as sales_part,
       case when s.ours and s.kind = 'refund' then s.amount - s.tax_part else 0 end as refund_part,
       case when s.ours and s.kind = 'charge' and s.order_id is not null then
         round(coalesce(c.cogs, 0) * case when s.o_total > 0 then least(1, greatest(0, s.amount / s.o_total)) else 1 end, 2) else 0 end as cogs,
       case when s.ours and s.kind = 'charge' and coalesce(c.no_cost, 0) > 0 then true else false end as missing_cost,
       not s.ours as a2x,
       case when not s.ours then s.amount else 0 end as pending_part
from s
left join lateral (select sum(a.cogs + a.cost_added) as cogs, sum(a.net_no_cost_adj) as no_cost from jt.v_sales_adjusted a where a.order_id = s.order_id) jc on s.store = 'justtennis' and s.ours and s.kind = 'charge'
left join fin.v_anr_order_cogs ac on s.store = 'acenrally' and ac.order_id = s.order_id and s.ours and s.kind = 'charge'
cross join lateral (select coalesce(jc.cogs, ac.cogs) as cogs, coalesce(jc.no_cost, ac.no_cost) as no_cost) c;

create or replace view fin.v_shop_payouts as
select p.id, p.issued_at, (p.issued_at at time zone 'UTC')::date as payout_date, p.status, p.amount, p.currency, p.posted, p.a2x_docs, p.checked_at, p.synced_at,
       count(x.id) as tx, count(distinct x.order_id) filter (where x.kind = 'charge' and not x.a2x) as orders,
       coalesce(sum(x.sales_part), 0) as sales, coalesce(sum(x.ship_part), 0) as shipping,
       coalesce(sum(x.tax_part), 0) + coalesce(sum(x.amount) filter (where x.kind = 'taxadj' and not x.a2x), 0) as tax,
       coalesce(sum(x.refund_part), 0) as refunds,
       -coalesce(sum(x.fee), 0) as fees,
       coalesce(sum(x.amount) filter (where x.kind in ('dispute', 'shopcash', 'other') and not x.a2x), 0) as other,
       coalesce(sum(x.net), 0) as net, coalesce(sum(x.cogs), 0) as cogs,
       count(distinct x.order_id) filter (where x.missing_cost) as orders_missing_cost,
       coalesce(sum(x.pending_part), 0) as a2x_pending, count(*) filter (where x.a2x) as a2x_tx, p.store
from fin.shopify_payouts p
left join fin.v_shop_tx x on x.payout_id = p.id and x.store = p.store
group by p.id;

create or replace function fin.shop_entry(pid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p record; cfg jsonb;
  x record; lines jsonb := '[]'::jsonb; out jsonb := '[]'::jsonb; probs jsonb := '[]'::jsonb; doc text; cdoc text; others text;
begin
  select * into p from fin.v_shop_payouts where id = pid;
  if not found then return null; end if;
  cfg := fin.shop_cfg(p.store);
  doc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(p.payout_date, 'DDMon') || '-' || right(pid, 3);
  cdoc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(p.payout_date, 'DDMon') || 'C' || right(pid, 3);
  select count(*) filter (where kind = 'charge') as charges, count(distinct order_id) filter (where kind = 'charge' and not a2x) as orders,
         count(*) filter (where kind = 'refund' and not a2x) as refunds, count(*) filter (where kind = 'dispute' and not a2x) as disputes,
         coalesce(sum(pending_part), 0) as pending, count(*) filter (where a2x) as pending_n,
         coalesce(sum(sales_part), 0) as sales, coalesce(sum(ship_part), 0) as ship,
         coalesce(sum(tax_part) filter (where kind = 'charge'), 0) as tax_in, coalesce(sum(tax_part) filter (where kind = 'refund'), 0) as tax_out,
         coalesce(sum(refund_part), 0) as refund, coalesce(sum(fee), 0) as fee,
         coalesce(sum(amount) filter (where kind = 'dispute' and not a2x), 0) as dispute, coalesce(sum(amount) filter (where kind = 'shopcash' and not a2x), 0) as shopcash,
         coalesce(sum(amount) filter (where kind = 'taxadj' and not a2x), 0) as taxadj, coalesce(sum(amount) filter (where kind = 'other' and not a2x), 0) as other,
         coalesce(sum(net), 0) as net, coalesce(sum(cogs), 0) as cogs
    into x from fin.v_shop_tx where payout_id = pid and store = p.store;
  select string_agg(distinct type, ', ') into others from fin.v_shop_tx where payout_id = pid and store = p.store and kind = 'other' and not a2x;
  -- + = debit, − = credit; money in (sales, shipping, tax) is a credit
  lines := jsonb_build_array(
    jsonb_build_object('account', cfg->>'sales', 'amount', -x.sales, 'description', format('Sales after discounts · %s order%s', x.orders, case when x.orders = 1 then '' else 's' end)),
    jsonb_build_object('account', cfg->>'shipping', 'amount', -x.ship, 'description', 'Shipping charged'),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.tax_in, 'description', 'Sales tax collected'),
    jsonb_build_object('account', cfg->>'refunds', 'amount', -x.refund, 'description', format('Refunds · %s', x.refunds)),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.tax_out, 'description', 'Sales tax refunded'),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.taxadj, 'description', 'Tax adjustments (tax Shopify remits, e.g. Shop app orders)'),
    jsonb_build_object('account', cfg->>'fees', 'amount', x.fee, 'description', 'Shopify Payments fees'),
    jsonb_build_object('account', cfg->>'fees', 'amount', -x.dispute, 'description', format('Chargebacks · %s', x.disputes)),
    jsonb_build_object('account', fin.shop_gateway_account('shop_cash', p.store), 'amount', -x.shopcash, 'description', 'Shop Cash paid back by Shopify (clears the Shop Cash payments on orders)'),
    jsonb_build_object('account', cfg->>'fees', 'amount', -x.other, 'description', 'Other: ' || coalesce(others, ''), 'review', true),
    jsonb_build_object('account', coalesce(cfg->>'pending', 'Shopify Pending Balances'), 'amount', -x.pending,
      'description', format('Paid now for orders and refunds A2X already booked (through %s) · %s', to_char((cfg->>'a2x_until')::date, 'Mon DD'), x.pending_n)));
  select coalesce(jsonb_agg(l), '[]'::jsonb) into lines from jsonb_array_elements(lines) l where round((l->>'amount')::numeric, 2) <> 0;
  lines := lines || jsonb_build_array(jsonb_build_object('account', cfg->>'bank', 'amount', p.amount,
    'description', coalesce(cfg->>'label', 'Shopify') || ' payout ' || to_char(p.payout_date, 'YYYY-MM-DD') || ' (#' || pid || ')'));
  out := jsonb_build_array(jsonb_build_object('doc', doc, 'date', p.payout_date, 'kind', 'main', 'currency', p.currency, 'fx', 1, 'lines', lines, 'posted', p.posted->doc));
  if round(x.cogs, 2) <> 0 then
    out := out || jsonb_build_array(jsonb_build_object('doc', cdoc, 'date', p.payout_date, 'kind', 'cogs', 'currency', 'USD', 'fx', 1, 'posted', p.posted->cdoc,
      'lines', jsonb_build_array(
        jsonb_build_object('account', cfg->>'cogs', 'amount', round(x.cogs, 2), 'description', format('Cost of goods sold · %s Shopify order%s', x.orders, case when x.orders = 1 then '' else 's' end)),
        jsonb_build_object('account', cfg->>'inventory', 'amount', -round(x.cogs, 2), 'description', 'Inventory deduction (Shopify sales)'))));
  end if;
  if x.charges + x.refunds + x.disputes = 0 and round(x.net, 2) = 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', 'No Shopify Payments transactions are linked to this payout yet — they come in with the hourly Shopify sync.'));
  elsif round(x.net, 2) <> round(p.amount, 2) then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', format('The transactions add to %s but the payout is %s — some may not have come in from Shopify yet.', round(x.net, 2), p.amount)));
  end if;
  if p.currency <> 'USD' then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', 'This payout isn''t in USD.'));
  end if;
  if p.orders_missing_cost > 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'cost', 'message', p.orders_missing_cost || ' order(s) have items with no cost, so those items are left out of cost of goods.'));
  end if;
  if others is not null then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'other', 'message', 'Some transactions aren''t sales, refunds, fees, chargebacks, Shop Cash or tax adjustments (' || others || ') — they''re on the fees account; check them.'));
  end if;
  return jsonb_build_object('payout', to_jsonb(p), 'parts', out, 'problems', probs);
end $$;

create or replace function public.fin_shop_open_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(p.id order by p.issued_at), '{}') from fin.shopify_payouts p
  where p.posted = '{}'::jsonb and cardinality(p.a2x_docs) = 0 and p.status = 'PAID'
    and p.issued_at >= (coalesce(fin.shop_cfg(p.store)->>'start', '2026-10-01'))::date - 14
$$;

create or replace view fin.v_shop_other_tx as
with t as (
  select p.*, case when p.kind = 'REFUND' then -p.amount else p.amount end as signed,
         (p.processed_at at time zone 'America/Los_Angeles')::date as day,
         o.total as o_total, o.tax as o_tax, o.shipping as o_shipping, o.name as o_name, o.order_day as o_day,
         fin.shop_gateway_account(p.gateway, p.store) as account,
         coalesce(fin.shop_cfg(p.store)->'gateways' ? lower(p.gateway), false) as known
  from jt.shopify_order_payments p left join fin.v_shop_orders o on o.store = p.store and o.order_id = p.order_id
  where not p.test and lower(p.gateway) <> 'shopify_payments'),
c as (
  select t.*, (t.day - extract(isodow from t.day)::int + 7) as week_end,
         coalesce(case when t.kind <> 'REFUND' then t.o_day > u.until else t.day > u.until end, true) as ours,
         t.day > coalesce(u.until, '1900-01-01') as after_switch
  from t cross join lateral (select (fin.shop_cfg(t.store)->>'a2x_until')::date as until) u)
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
left join lateral (select sum(a.cogs + a.cost_added) as cogs, sum(a.net_no_cost_adj) as no_cost from jt.v_sales_adjusted a where a.order_id = c.order_id) jk on c.store = 'justtennis' and c.ours and c.kind <> 'REFUND'
left join fin.v_anr_order_cogs ak on c.store = 'acenrally' and ak.order_id = c.order_id and c.ours and c.kind <> 'REFUND'
cross join lateral (select coalesce(jk.cogs, ak.cogs) as cogs, coalesce(jk.no_cost, ak.no_cost) as no_cost) k;

-- weekly other-payment entries are kept per store
alter table fin.shop_pay_weeks add column if not exists store text not null default 'justtennis';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'shop_pay_weeks_store_pkey') then
    alter table fin.shop_pay_weeks drop constraint if exists shop_pay_weeks_pkey;
    alter table fin.shop_pay_weeks add constraint shop_pay_weeks_store_pkey primary key (store, week_end);
  end if;
end $$;

create or replace view fin.v_shop_pay_weeks as
with x as (select * from fin.v_shop_other_tx where after_switch),
g as (select store, week_end, jsonb_object_agg(gateway, amt) as by_gateway from (select store, week_end, gateway, sum(amount) as amt from x group by 1, 2, 3) q group by 1, 2)
select x.week_end, x.week_end - 6 as week_start, coalesce(w.posted, '{}'::jsonb) as posted, w.checked_at,
       x.week_end < (now() at time zone 'America/Los_Angeles')::date as complete,
       count(*) as payments, count(distinct x.order_id) as orders,
       sum(x.amount) as amount, sum(x.sales_part) as sales, sum(x.ship_part) as shipping, sum(x.tax_part) as tax,
       sum(x.refund_part) as refunds, sum(x.pending_part) as a2x_pending, sum(x.cogs) as cogs,
       count(distinct x.order_id) filter (where x.missing_cost) as orders_missing_cost,
       count(*) filter (where not x.known) as unknown_gateway, max(g.by_gateway::text)::jsonb as by_gateway, x.store
from x
left join fin.shop_pay_weeks w on w.store = x.store and w.week_end = x.week_end
left join g on g.store = x.store and g.week_end = x.week_end
group by x.store, x.week_end, w.posted, w.checked_at;

create or replace function fin.shop_pay_entry(we date, st text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  w record; cfg jsonb := fin.shop_cfg(st);
  x record; lines jsonb; out jsonb := '[]'::jsonb; probs jsonb := '[]'::jsonb; doc text; cdoc text; clr jsonb;
begin
  select * into w from fin.v_shop_pay_weeks where week_end = we and store = st;
  if not found then return null; end if;
  doc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(we, 'DDMon') || '-PAY';
  cdoc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(we, 'DDMon') || 'CPAY';
  select coalesce(jsonb_agg(jsonb_build_object('account', account, 'amount', amt, 'review', not known,
           'description', format('Paid in Shopify · %s · %s order%s', gws, n, case when n = 1 then '' else 's' end)) order by account), '[]'::jsonb)
    into clr
  from (select account, bool_and(known) as known, round(sum(amount), 2) as amt, string_agg(distinct gateway, ', ') as gws, count(distinct order_id) as n
        from fin.v_shop_other_tx where after_switch and week_end = we and store = st group by account) a where amt <> 0;
  select count(distinct order_id) filter (where kind <> 'REFUND' and not a2x) as orders, count(*) filter (where kind = 'REFUND' and not a2x) as refunds,
         count(*) filter (where a2x) as pending_n,
         coalesce(sum(sales_part), 0) as sales, coalesce(sum(ship_part), 0) as ship,
         coalesce(sum(tax_part) filter (where kind <> 'REFUND'), 0) as tax_in, coalesce(sum(tax_part) filter (where kind = 'REFUND'), 0) as tax_out,
         coalesce(sum(refund_part), 0) as refund, coalesce(sum(pending_part), 0) as pending, coalesce(sum(cogs), 0) as cogs
    into x from fin.v_shop_other_tx where after_switch and week_end = we and store = st;
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
        jsonb_build_object('account', cfg->>'cogs', 'amount', round(x.cogs, 2), 'description', format('Cost of goods sold · %s ' || coalesce(cfg->>'label', 'Shopify') || ' order%s (manual, cash, PayPal …)', x.orders, case when x.orders = 1 then '' else 's' end)),
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

-- (the one-argument versions stay for Just Tennis)
create or replace function fin.shop_pay_entry(we date) returns jsonb
language sql stable security definer set search_path = '' as $$ select fin.shop_pay_entry(we, 'justtennis') $$;

create or replace function public.fin_shop_pay_entry(we date, st text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (fin.is_user() or coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return fin.shop_pay_entry(we, st);
end $$;

create or replace function public.fin_shop_week_posted(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare st text := coalesce(nullif(p->>'store', ''), 'justtennis');
begin
  insert into fin.shop_pay_weeks (store, week_end) values (st, (p->>'week_end')::date) on conflict do nothing;
  update fin.shop_pay_weeks set
    posted = case when p ? 'doc' and coalesce(p->>'id', '') <> '' then posted || jsonb_build_object(p->>'doc', jsonb_build_object('id', p->>'id', 'at', now(), 'by', coalesce(p->>'by', ''), 'how', coalesce(p->>'how', 'created')))
                  else posted end,
    checked_at = case when coalesce((p->>'checked')::boolean, false) then now() else checked_at end
  where store = st and week_end = (p->>'week_end')::date;
  return found;
end $$;

create or replace view fin.v_shop_due as
select d.order_id, d.name, d.created_at, (d.created_at at time zone 'America/Los_Angeles')::date as order_day, d.source_name, d.financial_status,
       d.total, d.outstanding, d.total - d.outstanding as paid, d.gateways,
       (now() at time zone 'America/Los_Angeles')::date - (d.created_at at time zone 'America/Los_Angeles')::date as days_old, d.synced_at, d.store
from jt.shopify_order_due d
where d.outstanding > 0 and not d.cancelled and not d.test
  and d.financial_status not in ('AUTHORIZED', 'VOIDED', 'REFUNDED')
  and not exists (select 1 from fin.shop_due_closed c where c.store = d.store and c.order_id = d.order_id);

create or replace view fin.v_shop_due_closed as
select c.order_id, coalesce(d.name, '') as name, (d.created_at at time zone 'America/Los_Angeles')::date as order_day, d.total, c.outstanding, c.note, c.closed_by, c.closed_at, c.store
from fin.shop_due_closed c left join jt.shopify_order_due d on d.store = c.store and d.order_id = c.order_id;

create or replace function public.fin_shop_due_close(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', ''); oid bigint := (p->>'order_id')::bigint; st text := coalesce(nullif(p->>'store', ''), 'justtennis');
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce((p->>'reopen')::boolean, false) then
    delete from fin.shop_due_closed where store = st and order_id = oid;
    return found;
  end if;
  insert into fin.shop_due_closed (store, order_id, outstanding, note, closed_by)
  select st, oid, coalesce((select outstanding from jt.shopify_order_due where store = st and order_id = oid), 0), coalesce(p->>'note', ''), who
  on conflict (store, order_id) do update set note = excluded.note, closed_by = excluded.closed_by, closed_at = now();
  return true;
end $$;

revoke all on function public.fin_shop_pay_entry(date, text) from public;
grant select on fin.v_shop_orders, fin.v_anr_order_cogs to fin_reader;
grant execute on function fin.shop_cfg(text), fin.shop_gateway_account(text, text), fin.shop_pay_entry(date, text) to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_shop_pay_entry(date, text) from anon;
    grant execute on function public.fin_shop_pay_entry(date, text) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_shop_pay_entry(date, text) to service_role;
  end if;
end $$;
