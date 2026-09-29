-- Tracking numbers on Shopify orders (from their fulfillments; ShipStation writes them back when it ships), so an
-- order with no ShipStation label of its own can be matched to the label that shipped it: ShipStation combines orders
-- into one shipment and puts the label on one of them, but every combined order gets the same tracking number.

create table if not exists jt.shopify_order_tracking (
  order_id  bigint not null,
  tracking  text not null,                        -- normalized: upper case, no spaces
  company   text not null default '',
  primary key (order_id, tracking)
);
create index if not exists shopify_order_tracking_tracking_idx on jt.shopify_order_tracking (tracking);
create index if not exists shipstation_labels_tracking_norm_idx on jt.shipstation_labels ((upper(replace(tracking, ' ', ''))));

-- Orders with no label of their own whose tracking number is on another order's label: shipped combined with it.
create or replace view jt.v_combined_shipments as
select distinct on (t.order_id) t.order_id, l.order_id as label_order_id, o2.name as label_order_name, t.tracking
from jt.shopify_order_tracking t
join jt.shipstation_labels l on upper(replace(l.tracking, ' ', '')) = t.tracking and not l.voided and l.order_id <> t.order_id
join jt.shopify_orders o2 on o2.order_id = l.order_id
where not exists (select 1 from jt.shipstation_labels own where own.order_id = t.order_id and not own.voided)
order by t.order_id, l.ship_date desc nulls last;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.shopify_order_tracking, jt.v_combined_shipments to jt_reader;
  end if;
end $$;
