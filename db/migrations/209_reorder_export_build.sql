-- 209: the reorder export's data (migration 207) takes ~6 s to build from a year of Amazon order lines, longer than
-- the API's statement timeout. It is now built by cron (jt.reorder_export_build, hourly at :40, no timeout there) into
-- jt.docs 'reorder_export'/'data', and public.jt_reorder_export_data() just returns that copy.
-- "Total Order Items" is now the count of order lines (one per order and SKU), as Amazon counts order items.

create or replace function jt.reorder_export_build()
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare d jsonb;
begin
  with lines as (
    select l.asin, l.quantity, l.item_price, l.is_business, l.product_name
    from jt.amazon_order_lines l
    where l.marketplace = 'us' and l.order_status <> 'Cancelled' and coalesce(l.asin, '') <> ''
      and l.purchase_at >= now() - interval '365 days'
  ), biz as (
    select asin, max(product_name) as title,
      sum(quantity) as units, coalesce(sum(quantity) filter (where is_business), 0) as units_b2b,
      round(sum(item_price), 2) as sales, round(coalesce(sum(item_price) filter (where is_business), 0), 2) as sales_b2b,
      count(*) as items, count(*) filter (where is_business) as items_b2b
    from lines group by asin
  ), names as (
    select f.sku, nullif(f.name, '') as name, f.fnsku, nullif(f.asin, '') as asin from jt.fba_inventory f
  ), awd as (
    select a.sku, coalesce(f.name, '') as name, coalesce(f.fnsku, '') as fnsku, coalesce(f.asin, '') as asin,
      a.inbound, a.available, a.reserved, a.replenishment,
      coalesce(fi.fulfillable, 0) as fba_available, coalesce(fi.reserved_total, 0) as fba_reserved,
      coalesce(fi.reserved_customer, 0) as customer_order, coalesce(fi.reserved_processing, 0) as fc_processing,
      coalesce(fi.reserved_transfer, 0) as fc_transfer
    from jt.awd_inventory a
      left join names f on f.sku = a.sku
      left join jt.fba_inventory fi on fi.sku = a.sku
    where a.active
  )
  select jsonb_build_object(
    'built_at', now(),
    'business', coalesce((select jsonb_agg(jsonb_build_array(asin, asin, title, '', '', '', '', '', '', '', '', '', '',
        units, units_b2b, '', '', sales, sales_b2b, items, items_b2b) order by units desc) from biz), '[]'::jsonb),
    'awd', coalesce((select jsonb_agg(jsonb_build_array(name, sku, fnsku, asin, inbound, '', available, '', available, '',
        reserved, '', 0, '', 0, '', replenishment, fba_available, '', fba_reserved, customer_order, fc_processing, fc_transfer, '', '')
        order by sku) from awd), '[]'::jsonb),
    'awd_synced_at', (select value->>'synced_at' from jt.settings where key = 'awd_inventory'),
    'orders_through', (select max(purchase_at) from jt.amazon_order_lines where marketplace = 'us'))
  into d;
  insert into jt.docs (collection, id, data, updated_at) values ('reorder_export', 'data', d, now())
  on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  return jsonb_array_length(d->'business');
end $function$;

create or replace function public.jt_reorder_export_data()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  select data from jt.docs where collection = 'reorder_export' and id = 'data';
$function$;

select cron.schedule('jt-reorder-export-build', '40 * * * *', $$select jt.reorder_export_build()$$);
select jt.reorder_export_build();
