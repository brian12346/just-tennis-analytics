-- FBM stock: which Shopify location the units came from (recorded per order), and a name for the location the
-- dashboard shows (the app can't read location names from Shopify — no read_locations scope — so it's typed in).
alter table jt.fbm_decisions add column if not exists location_id text;

create or replace view jt.v_fbm_lines as
with cfg as (select coalesce((select value from jt.settings where key = 'fbm_sync'), '{}'::jsonb) as v),
maps as materialized (
  select data->>'sku' as sku, data->>'kind' as kind,
         nullif(regexp_replace(coalesce(data->>'variantId', ''), '^.*/', ''), '')::bigint as variant_id,
         greatest(coalesce(nullif(data->>'units', '')::numeric, 1), 1) as map_units
  from jt.docs where collection = 'amzmap'
)
select l.order_id, l.sku, l.asin, l.product_name, l.quantity, l.order_status, l.item_status, l.marketplace,
       l.purchase_at, (l.purchase_at at time zone 'America/Los_Angeles')::date as day,
       l.order_status like 'Shipped%' as shipped,
       l.order_status = 'Cancelled' or l.item_status = 'Cancelled' as cancelled,
       m.kind as map_kind, m.variant_id, m.map_units,
       case when m.kind = 'shopify' and m.variant_id is not null then (l.quantity * m.map_units)::int end as units,
       v.display_name as shopify_title, v.sku as shopify_sku, v.inventory_qty as shopify_qty, v.inventory_item_id,
       v.product_id, v.tracked,
       d.decision, d.status, d.error, d.decided_by, d.decided_at, d.applied_at, d.shopify_before, d.units as decided_units,
       d.location_id
from jt.amazon_order_lines l
cross join cfg
left join maps m on m.sku = l.sku
left join jt.variants v on v.variant_id = m.variant_id
left join jt.fbm_decisions d on d.order_id = l.order_id and d.sku = l.sku
where l.fulfillment = 'Merchant'
  and l.marketplace in ('us', 'ca', 'mx')
  and (l.purchase_at at time zone 'America/Los_Angeles')::date >= coalesce((cfg.v->>'start')::date, current_date - 7);

-- p = {start?: 'YYYY-MM-DD', location_name?: text}
create or replace function jt.fbm_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p ? 'start' and (p->>'start')::date is null then raise exception 'start must be a date'; end if;
  if p ? 'location_name' and length(coalesce(p->>'location_name', '')) > 80 then raise exception 'location name is too long'; end if;
  insert into jt.settings (key, value) values ('fbm_sync', jsonb_build_object('start', coalesce(p->>'start', '2026-09-25')))
  on conflict (key) do nothing;
  update jt.settings set value = value
      || jsonb_strip_nulls(jsonb_build_object('start', p->>'start'))
      || case when p ? 'location_name' then jsonb_build_object('location_name', btrim(p->>'location_name')) else '{}'::jsonb end,
    updated_at = now()
  where key = 'fbm_sync'
  returning value into v;
  return v;
end $$;
