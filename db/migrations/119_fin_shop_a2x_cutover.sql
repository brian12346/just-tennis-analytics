-- Finance › Shopify payouts (Oct 11): the switch from A2X. A2X booked Shopify sales on the order's day (and refunds on
-- the refund's day), with the money owed in "Shopify Pending Balances" until the payout came; its last entries cover
-- through Sep 27. So in our payouts, a charge for an order placed on or before that day (or a refund / adjustment
-- processed by then) isn't a sale again: it clears Shopify Pending Balances, and it gets no cost of goods (A2X booked
-- that too). The day is fin.settings 'shop_post' a2x_until.

update fin.settings set value = value || jsonb_build_object('a2x_until', '2026-09-27', 'pending', 'Shopify Pending Balances')
where key = 'shop_post' and not value ? 'a2x_until';

create or replace view fin.v_shop_tx as
with t as (
  select t.*, o.total as o_total, o.tax as o_tax, o.shipping as o_shipping, o.name as o_name,
         case when t.type = 'CHARGE' then 'charge' when t.type = 'REFUND' then 'refund' when t.type like 'DISPUTE%' then 'dispute'
              when t.type like 'SHOP_CASH%' then 'shopcash' when t.type like 'TAX_ADJUSTMENT%' then 'taxadj' else 'other' end as kind
  from jt.shopify_payment_tx t left join jt.shopify_orders o on o.order_id = t.order_id
  where t.store = 'justtennis' and not t.test and t.payout_id <> ''),
c as (
  select t.*, coalesce(case when t.kind = 'charge' then t.o_day > u.until else (t.processed_at at time zone 'America/Los_Angeles')::date > u.until end, true) as ours
  from (select t.*, o2.order_day as o_day from t left join jt.shopify_orders o2 on o2.order_id = t.order_id) t
  cross join (select (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post') as until) u),
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
left join lateral (select sum(a.cogs + a.cost_added) as cogs, sum(a.net_no_cost_adj) as no_cost from jt.v_sales_adjusted a where a.order_id = s.order_id) c on s.ours and s.kind = 'charge';

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
       coalesce(sum(x.pending_part), 0) as a2x_pending, count(*) filter (where x.a2x) as a2x_tx
from fin.shopify_payouts p
left join fin.v_shop_tx x on x.payout_id = p.id
group by p.id;

create or replace function fin.shop_entry(pid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p record; cfg jsonb := coalesce((select value from fin.settings where key = 'shop_post'), '{}'::jsonb);
  x record; lines jsonb := '[]'::jsonb; out jsonb := '[]'::jsonb; probs jsonb := '[]'::jsonb; doc text; cdoc text; others text;
begin
  select * into p from fin.v_shop_payouts where id = pid;
  if not found then return null; end if;
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
    into x from fin.v_shop_tx where payout_id = pid;
  select string_agg(distinct type, ', ') into others from fin.v_shop_tx where payout_id = pid and kind = 'other' and not a2x;
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
    jsonb_build_object('account', cfg->>'fees', 'amount', -x.shopcash, 'description', 'Shop Cash'),
    jsonb_build_object('account', cfg->>'fees', 'amount', -x.other, 'description', 'Other: ' || coalesce(others, ''), 'review', true),
    jsonb_build_object('account', coalesce(cfg->>'pending', 'Shopify Pending Balances'), 'amount', -x.pending,
      'description', format('Paid now for orders and refunds A2X already booked (through %s) · %s', to_char((cfg->>'a2x_until')::date, 'Mon DD'), x.pending_n)));
  select coalesce(jsonb_agg(l), '[]'::jsonb) into lines from jsonb_array_elements(lines) l where round((l->>'amount')::numeric, 2) <> 0;
  lines := lines || jsonb_build_array(jsonb_build_object('account', cfg->>'bank', 'amount', p.amount,
    'description', 'Shopify payout ' || to_char(p.payout_date, 'YYYY-MM-DD') || ' (#' || pid || ')'));
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
