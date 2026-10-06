-- Ace n Rally payment fees count on the order's day from its sales lines (jt.anr_orders only goes back to Aug 2026).
create or replace view jt.v_shopify_payment_fees as
with anr_days as (select order_id, min(day) as order_day from jt.anr_sales where order_id <> 0 group by order_id)
select t.store, coalesce(case t.store when 'justtennis' then o.order_day else a.order_day end,
                         (t.processed_at at time zone 'America/Los_Angeles')::date) as day,
       t.type, t.order_id, t.amount, t.fee, t.net
from jt.shopify_payment_tx t
left join jt.shopify_orders o on t.store = 'justtennis' and o.order_id = t.order_id
left join anr_days a on t.store = 'acenrally' and a.order_id = t.order_id
where not t.test;
