-- Ace n Rally shipping: ShipStation is shared with Just Tennis, and the label sync (jt.shipstation_labels) already
-- stores every label with its Shopify order id, whichever store the order came from. Ace n Rally's labels are the ones
-- whose order id is an Ace n Rally order. Costed on the order's day (its first sale day), like Just Tennis.
create or replace view jt.v_anr_order_shipping as
with o as (
  select order_id, min(day) as order_day, max(order_name) as order_name, sum(net) as net, sum(units) as units
  from jt.anr_sales where order_id <> 0 group by order_id
),
l as (
  select order_id, sum(cost) as cost, count(*) as labels, min(ship_date) as ship_date,
         string_agg(distinct service, ', ') filter (where service <> '') as services
  from jt.shipstation_labels where not voided and order_id is not null group by order_id
)
select o.order_id, o.order_day, o.order_name, o.net, o.units, coalesce(l.cost, 0) as label_cost, coalesce(l.labels, 0) as labels,
       l.ship_date, coalesce(l.services, '') as services
from o left join l using (order_id);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.v_anr_order_shipping to jt_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.v_anr_order_shipping to fin_reader; end if;
end $$;
