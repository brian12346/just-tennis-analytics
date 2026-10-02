-- FBM stock tab, "FBM listings Shopify has in stock" panel: stock at the FBM location only, and sending quantities to
-- Amazon.
--
-- jt.location_stock: Shopify's available quantity per inventory item at the FBM location (jt.settings
-- fbm_sync.location_id, 9925 Businesspark Avenue), written by the sync job (sync/shopify.py sync_location_stock:
-- hourly, nightly, after FBM stock changes, and job "location-stock" from the page's refresh button).
create table if not exists jt.location_stock (
  location_id       text not null,
  inventory_item_id bigint not null,
  available         integer not null default 0,
  updated_at        timestamptz not null default now(),
  primary key (location_id, inventory_item_id)
);

-- jt.fbm_pushes: every quantity sent to Amazon for an FBM listing (the `amazon` edge function, action fbm_qty, which
-- patches the listing's fulfillment_availability through the Listings Items API). preview = Amazon's
-- VALIDATION_PREVIEW mode: checked, nothing changed.
create table if not exists jt.fbm_pushes (
  id            bigserial primary key,
  sku           text not null,
  asin          text not null default '',
  quantity      integer not null,
  amazon_before integer,
  preview       boolean not null default false,
  status        text not null,                 -- ACCEPTED | INVALID | failed
  issues        jsonb not null default '[]'::jsonb,
  error         text not null default '',
  requested_by  text not null default '',
  requested_at  timestamptz not null default now()
);
create index if not exists fbm_pushes_sku on jt.fbm_pushes (sku, requested_at desc);

-- p = {sku, asin, quantity, amazon_before, preview, status, issues, error, by}
create or replace function public.jt_amazon_fbm_push_save(p jsonb) returns bigint
language sql security definer set search_path = '' as $$
  insert into jt.fbm_pushes (sku, asin, quantity, amazon_before, preview, status, issues, error, requested_by)
  values (p->>'sku', coalesce(p->>'asin', ''), (p->>'quantity')::int, (p->>'amazon_before')::int, coalesce((p->>'preview')::boolean, false),
          coalesce(p->>'status', 'failed'), coalesce(p->'issues', '[]'::jsonb), coalesce(p->>'error', ''), coalesce(p->>'by', ''))
  returning id;
$$;

-- the refresh button: ask the sync job for fresh stock at the FBM location
create or replace function public.jt_request_location_stock() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if to_regprocedure('jt.dispatch_sync(text)') is null then return false; end if;
  perform jt.dispatch_sync('location-stock');
  return true;
end $$;

-- FBM listings mapped to a Shopify variant with stock at the FBM location. Until the first location-stock sync has
-- run, the variant's total stock is used (stock_source 'total'). amazon_qty_now is the last quantity sent to Amazon
-- when that's newer than the listings report.
-- (columns of 057 first, in the same order, so create or replace can update it in place)
create or replace view jt.v_fbm_listings as
with cfg as (select (select value->>'location_id' from jt.settings where key = 'fbm_sync') as loc),
lst as (
  select r->>0 as sku, coalesce(r->>1, '') as asin, coalesce(r->>2, '') as title,
         nullif(r->>3, '')::numeric as amazon_price, nullif(r->>4, '')::int as amazon_qty, coalesce(r->>6, '') as amazon_status,
         d.data->>'file' as report_file, (d.data->>'uploadedAt')::timestamptz as report_at
  from jt.docs d, jsonb_array_elements(d.data->'rows') r
  where d.collection = 'amzlistings' and r->>5 = 'DEFAULT'
),
maps as materialized (
  select data->>'sku' as sku,
         nullif(regexp_replace(coalesce(data->>'variantId', ''), '^.*/', ''), '')::bigint as variant_id,
         greatest(coalesce(nullif(data->>'units', '')::numeric, 1), 1) as map_units
  from jt.docs where collection = 'amzmap' and data->>'kind' = 'shopify'
),
synced as (select exists (select 1 from jt.location_stock s, cfg where s.location_id = cfg.loc) as yes),
pushed as (
  select distinct on (sku) sku, quantity, status, issues, error, requested_at, requested_by
  from jt.fbm_pushes where not preview order by sku, requested_at desc
)
select l.sku, l.asin, l.title, l.amazon_status, l.amazon_qty, l.amazon_price, l.report_file, l.report_at,
       m.variant_id, m.map_units, v.product_id, v.display_name as shopify_title, v.sku as shopify_sku,
       case when synced.yes then coalesce(ls.available, 0) else v.inventory_qty end as shopify_qty,
       floor(greatest(case when synced.yes then coalesce(ls.available, 0) else v.inventory_qty end, 0) / m.map_units)::int as packs,
       v.price as shopify_price,
       v.inventory_qty as shopify_total,
       case when synced.yes then 'location' else 'total' end as stock_source,
       case when pu.status = 'ACCEPTED' and (l.report_at is null or pu.requested_at > l.report_at) then pu.quantity else l.amazon_qty end as amazon_qty_now,
       pu.quantity as pushed_qty, pu.status as pushed_status, pu.requested_at as pushed_at, pu.requested_by as pushed_by,
       coalesce(nullif(pu.error, ''), (select string_agg(i->>'message', '; ') from jsonb_array_elements(pu.issues) i where i->>'severity' = 'ERROR')) as pushed_error
from lst l
cross join cfg
cross join synced
join maps m on m.sku = l.sku
join jt.variants v on v.variant_id = m.variant_id and v.removed_at is null
left join jt.location_stock ls on ls.location_id = cfg.loc and ls.inventory_item_id = v.inventory_item_id
left join pushed pu on pu.sku = l.sku
where (case when synced.yes then coalesce(ls.available, 0) else v.inventory_qty end) > 0
   or pu.sku is not null;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.v_fbm_listings, jt.location_stock, jt.fbm_pushes to jt_reader;
  end if;
end $$;

revoke all on function public.jt_amazon_fbm_push_save(jsonb), public.jt_request_location_stock() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_amazon_fbm_push_save(jsonb), public.jt_request_location_stock() from anon, authenticated;
    grant execute on function public.jt_request_location_stock() to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_amazon_fbm_push_save(jsonb) to service_role;
  end if;
end $$;
