-- Price match: retailers (Brian, Oct 17: "let's also look at tennis warehouse and tennis express"). Matched by UPC
-- across every brand, with Amazon, after the brand-site pass: the lowest of them is the price to meet (same floors and
-- restore rule as Amazon). See sync/price_sources.py.
--   Tennis Express   tennisexpress.com is a Shopify store with its own SKUs: each UPC is looked up once with the store's
--                    search (it searches barcodes), remembered for a month; prices come from /products/<handle>.js.
--   Tennis Warehouse brand category pages (from its sitemap; search pages are off limits in robots.txt) give prices;
--                    product pages give the UPCs of each size, read a few hundred a day and remembered for a month.
--                    The site turns away fast readers (406), so it's read slowly.
create table if not exists jt.pm_retail_map (
  source      text not null,
  key         text not null,                 -- UPC without leading zeros
  ref         text not null default '',      -- the retailer's product (handle / product id); '' = not sold there
  checked_at  timestamptz not null default now(),
  primary key (source, key)
);
create table if not exists jt.pm_retail_pages (
  source      text not null,
  ref         text not null,
  checked_at  timestamptz not null default now(),
  n_keys      integer not null default 0,
  primary key (source, ref)
);

insert into jt.pm_sources (name, kind, base_url, collections, sku_prefix, vendors, enabled, sort, match, options) values
  ('Tennis Warehouse', 'tw_catalog', 'https://www.tennis-warehouse.com', array['all'], 0, '{}', true, 20, 'barcode',
   '{"retail": true, "brands": ["babolat", "wilson", "head", "yonex", "dunlop", "tecnifibre", "kswiss", "new_balance", "luxilon"]}'),
  ('Tennis Express', 'shopify_upc_search', 'https://www.tennisexpress.com', array['all'], 0, '{}', true, 21, 'barcode',
   '{"retail": true}')
on conflict (name) do nothing;

-- Amazon prices for every brand's products, including brands whose own site is off (e.g. Tecnifibre)
create or replace function public.jt_pm_amazon_todo(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n_upc int := coalesce((p->>'upcs')::int, 200); n_asin int := coalesce((p->>'asins')::int, 200); r jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with vend as (select lower(regexp_replace(v, '[^a-zA-Z]', '', 'g')) v from jt.pm_sources s, unnest(s.vendors) v
                where not coalesce((s.options->>'retail')::boolean, false)),
  want as (
    select distinct btrim(x.barcode) upc from jt.variants x
    where x.status = 'ACTIVE' and btrim(coalesce(x.barcode, '')) ~ '^\d{12,14}$'
      and lower(regexp_replace(x.vendor, '[^a-zA-Z]', '', 'g')) in (select v from vend)
  )
  select jsonb_build_object(
    'upcs', coalesce((select jsonb_agg(w.upc) from (select w.upc from want w left join jt.pm_upc_asin u on u.upc = w.upc
                       where u.upc is null or u.checked_at < now() - interval '30 days' order by u.checked_at nulls first limit n_upc) w), '[]'::jsonb),
    'asins', coalesce((select jsonb_agg(a.asin) from (select distinct u.asin, a.checked_at from want w join jt.pm_upc_asin u on u.upc = w.upc
                        left join jt.pm_amazon_prices a on a.asin = u.asin
                        where u.asin <> '' and (a.asin is null or a.checked_at < now() - interval '18 hours') order by a.checked_at nulls first limit n_asin) a), '[]'::jsonb),
    'left_upcs', (select count(*) from want w left join jt.pm_upc_asin u on u.upc = w.upc where u.upc is null or u.checked_at < now() - interval '30 days'),
    'left_asins', (select count(distinct u.asin) from want w join jt.pm_upc_asin u on u.upc = w.upc left join jt.pm_amazon_prices a on a.asin = u.asin
                   where u.asin <> '' and (a.asin is null or a.checked_at < now() - interval '18 hours')))
  into r;
  return r;
end $$;
