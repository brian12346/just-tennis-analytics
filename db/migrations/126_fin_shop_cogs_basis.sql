-- Finance › Shopify payouts: an order's cost of goods is shared out over its payments by what the order comes to now
-- (current total + refunds), not its original total. Exchanges and order edits keep the swapped-out items in Shopify's
-- original total (#22401: a racquet exchanged for another grip size shows $669.48 though $334.74 was ever owed), which
-- counted only half its cost of goods. Refunds are added back so a part-paid order that was later refunded still
-- shares its cost by what was paid.
create or replace view fin.v_shop_orders as
select 'justtennis'::text as store, order_id, name, order_day, total, tax, shipping,
       coalesce(nullif(current_total + refunded, 0), total) as basis from jt.shopify_orders
union all
select 'acenrally', order_id, name, order_day, total, tax, shipping,
       coalesce(nullif(current_total + refunded, 0), total) from jt.anr_orders;

create or replace view fin.v_shop_tx as
with t as (
  select t.*, o.total as o_total, o.basis as o_basis, o.tax as o_tax, o.shipping as o_shipping, o.name as o_name, o.order_day as o_day,
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
         round(coalesce(c.cogs, 0) * case when s.o_basis > 0 then least(1, greatest(0, s.amount / s.o_basis)) else 1 end, 2) else 0 end as cogs,
       case when s.ours and s.kind = 'charge' and coalesce(c.no_cost, 0) > 0 then true else false end as missing_cost,
       not s.ours as a2x,
       case when not s.ours then s.amount else 0 end as pending_part
from s
left join lateral (select sum(a.cogs + a.cost_added) as cogs, sum(a.net_no_cost_adj) as no_cost from jt.v_sales_adjusted a where a.order_id = s.order_id) jc on s.store = 'justtennis' and s.ours and s.kind = 'charge'
left join fin.v_anr_order_cogs ac on s.store = 'acenrally' and ac.order_id = s.order_id and s.ours and s.kind = 'charge'
cross join lateral (select coalesce(jc.cogs, ac.cogs) as cogs, coalesce(jc.no_cost, ac.no_cost) as no_cost) c;

create or replace view fin.v_shop_other_tx as
with t as (
  select p.*, case when p.kind = 'REFUND' then -p.amount else p.amount end as signed,
         (p.processed_at at time zone 'America/Los_Angeles')::date as day,
         o.total as o_total, o.basis as o_basis, o.tax as o_tax, o.shipping as o_shipping, o.name as o_name, o.order_day as o_day,
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
         round(coalesce(k.cogs, 0) * case when c.o_basis > 0 then least(1, greatest(0, c.signed / c.o_basis)) else 1 end, 2) else 0 end as cogs,
       (c.ours and c.kind <> 'REFUND' and coalesce(k.no_cost, 0) > 0) as missing_cost
from c
left join lateral (select sum(a.cogs + a.cost_added) as cogs, sum(a.net_no_cost_adj) as no_cost from jt.v_sales_adjusted a where a.order_id = c.order_id) jk on c.store = 'justtennis' and c.ours and c.kind <> 'REFUND'
left join fin.v_anr_order_cogs ak on c.store = 'acenrally' and ak.order_id = c.order_id and c.ours and c.kind <> 'REFUND'
cross join lateral (select coalesce(jk.cogs, ak.cogs) as cogs, coalesce(jk.no_cost, ak.no_cost) as no_cost) k;
