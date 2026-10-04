-- Ace n Rally orders (the same order sync as Just Tennis: header, line items and tracking numbers), mainly so an order
-- that ShipStation shipped combined with another order (one label, the same tracking number on both) is matched to that
-- label instead of showing as "no label". The shared ShipStation account can also combine an Ace n Rally order with a
-- Just Tennis one, so the label can belong to either store's order.
create table if not exists jt.anr_orders (like jt.shopify_orders including all);
create table if not exists jt.anr_order_lines (like jt.shopify_order_lines including all);
create table if not exists jt.anr_order_tracking (like jt.shopify_order_tracking including all);
create index if not exists anr_order_lines_order_idx on jt.anr_order_lines (order_id);

create or replace view jt.v_anr_combined_shipments as
select distinct on (t.order_id) t.order_id, l.order_id as label_order_id,
       coalesce(a2.name, o2.name, '') as label_order_name, case when a2.order_id is not null then 'Ace n Rally' else 'Just Tennis' end as label_store,
       t.tracking
from jt.anr_order_tracking t
join jt.shipstation_labels l on upper(replace(l.tracking, ' ', '')) = t.tracking and not l.voided and l.order_id <> t.order_id
left join jt.anr_orders a2 on a2.order_id = l.order_id
left join jt.shopify_orders o2 on o2.order_id = l.order_id
where not exists (select 1 from jt.shipstation_labels own where own.order_id = t.order_id and not own.voided)
order by t.order_id, l.ship_date desc nulls last;

-- v_anr_order_shipping (migration 074) + who shipped it when it has no label of its own
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
       l.ship_date, coalesce(l.services, '') as services,
       coalesce(c.label_order_name, '') as combined_with, coalesce(c.label_store, '') as combined_store
from o left join l using (order_id)
left join jt.v_anr_combined_shipments c on c.order_id = o.order_id and l.order_id is null;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.anr_orders, jt.anr_order_lines, jt.anr_order_tracking, jt.v_anr_combined_shipments, jt.v_anr_order_shipping to jt_reader;
  end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.anr_orders, jt.v_anr_order_shipping to fin_reader; end if;
end $$;
