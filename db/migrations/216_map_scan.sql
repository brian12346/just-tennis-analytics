-- MAP scan (Nov 10, Brian: "goes through all of my Amazon ASINs and finds everyone breaking MAP on wilson products").
-- A scan takes every ASIN we sell on (any of our seller SKUs, jt.amazon_skus()) whose UPC is on the brand's newest MAP
-- file (pm_map_items -> pm_upc_asin), with the MAP in force today, and reads each listing's new offers from Amazon
-- (Product Pricing getItemOffersBatch: up to 20 offers each, lowest landed price first). Every offer is kept; one whose
-- item price (shipping not counted — MAP is the advertised price) is under MAP is a violation. The pm-amazon edge function
-- (action map_scan) does the Amazon side, about 20 ASINs every 10 seconds, picking up where it left off.

create table if not exists jt.map_scans (
  id           bigserial primary key,
  brand        text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  asins        integer not null default 0,
  by           text not null default ''
);

create table if not exists jt.map_scan_asins (
  scan_id      bigint not null references jt.map_scans (id) on delete cascade,
  asin         text not null,
  map_price    numeric not null,
  item_sku     text not null default '',
  upc          text not null default '',
  title        text not null default '',
  offers_total integer,
  error        text not null default '',
  checked_at   timestamptz,
  primary key (scan_id, asin)
);

create table if not exists jt.map_scan_offers (
  scan_id       bigint not null references jt.map_scans (id) on delete cascade,
  asin          text not null,
  seller_id     text not null,
  fba           boolean not null default false,
  listing_price numeric,
  shipping      numeric,
  buybox        boolean not null default false,
  prime         boolean not null default false,
  feedback_count integer,
  feedback_pct  numeric,
  ships_from    text not null default '',
  primary key (scan_id, asin, seller_id, fba)
);

-- the MAP in force today for each UPC on each brand's newest file (same steps as jt.v_pm_map_floor)
create or replace function jt.map_now(p_brand text)
returns table (item_sku text, upc text, map_price numeric)
language sql stable security definer set search_path = '' as $$
  with f as (select id from jt.pm_map_files where lower(brand) = lower(p_brand) order by id desc limit 1),
  steps as (select i.sku, ltrim(coalesce(i.upc, ''), '0') as upc, (e.value->>'d')::date as d, nullif(e.value->>'p', '')::numeric as p
            from f join jt.pm_map_items i on i.file_id = f.id cross join lateral jsonb_array_elements(i.maps) e(value)
            union all
            select i.sku, ltrim(coalesce(i.upc, ''), '0'), '1900-01-01'::date, i.prev_map from f join jt.pm_map_items i on i.file_id = f.id where i.prev_map is not null)
  select distinct on (upc) sku, upc, p from steps
  where upc <> '' and d <= (now() at time zone 'America/Los_Angeles')::date
  order by upc, d desc
$$;

-- the edge function (service role): p = {op: 'start', brand, by} -> {scan_id, asins}; {op: 'todo', scan_id, limit} -> [asin];
-- {op: 'save', scan_id, rows: [{asin, offers_total, error, offers: [{seller_id, fba, listing_price, shipping, buybox, prime, ...}]}]}
create or replace function public.jt_map_scan(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare sid bigint := nullif(p->>'scan_id', '')::bigint; n integer; r jsonb;
begin
  if p->>'op' = 'start' then
    insert into jt.map_scans (brand, by) values (coalesce(nullif(p->>'brand', ''), 'Wilson'), coalesce(p->>'by', '')) returning id into sid;
    insert into jt.map_scan_asins (scan_id, asin, map_price, item_sku, upc, title)
    select distinct on (u.asin) sid, u.asin, m.map_price, m.item_sku, m.upc, coalesce(u.title, '')
    from jt.map_now(coalesce(nullif(p->>'brand', ''), 'Wilson')) m
    join jt.pm_upc_asin u on u.asin <> '' and ltrim(u.upc, '0') = m.upc
    where m.map_price > 0 and u.asin in (select s.asin from jt.amazon_skus() s where s.asin <> '')
    order by u.asin, m.map_price desc;
    get diagnostics n = row_count;
    update jt.map_scans set asins = n where id = sid;
    return jsonb_build_object('scan_id', sid, 'asins', n);
  elsif p->>'op' = 'todo' then
    return coalesce((select jsonb_agg(asin) from (select asin from jt.map_scan_asins where scan_id = sid and checked_at is null
                     order by asin limit coalesce((p->>'limit')::int, 200)) x), '[]'::jsonb);
  elsif p->>'op' = 'save' then
    for r in select * from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) loop
      update jt.map_scan_asins set offers_total = nullif(r->>'offers_total', '')::int, error = coalesce(r->>'error', ''), checked_at = now()
      where scan_id = sid and asin = r->>'asin';
      insert into jt.map_scan_offers (scan_id, asin, seller_id, fba, listing_price, shipping, buybox, prime, feedback_count, feedback_pct, ships_from)
      -- a seller can have two offers on one listing the same way (FBA or not): keep its lowest
      select distinct on (o->>'seller_id', coalesce((o->>'fba')::boolean, false))
             sid, r->>'asin', o->>'seller_id', coalesce((o->>'fba')::boolean, false), nullif(o->>'listing_price', '')::numeric, nullif(o->>'shipping', '')::numeric,
             coalesce((o->>'buybox')::boolean, false), coalesce((o->>'prime')::boolean, false), nullif(o->>'feedback_count', '')::int,
             nullif(o->>'feedback_pct', '')::numeric, coalesce(o->>'ships_from', '')
      from jsonb_array_elements(coalesce(r->'offers', '[]'::jsonb)) o where coalesce(o->>'seller_id', '') <> ''
      order by o->>'seller_id', coalesce((o->>'fba')::boolean, false), nullif(o->>'listing_price', '')::numeric nulls last
      on conflict (scan_id, asin, seller_id, fba) do update set listing_price = excluded.listing_price, shipping = excluded.shipping,
        buybox = excluded.buybox, prime = excluded.prime, feedback_count = excluded.feedback_count, feedback_pct = excluded.feedback_pct, ships_from = excluded.ships_from;
    end loop;
    update jt.map_scans set finished_at = now() where id = sid and finished_at is null
      and not exists (select 1 from jt.map_scan_asins a where a.scan_id = sid and a.checked_at is null);
    return jsonb_build_object('left', (select count(*) from jt.map_scan_asins where scan_id = sid and checked_at is null));
  end if;
  raise exception 'unknown op %', p->>'op';
end $$;

-- every offer under MAP on the newest scan of each brand (Just Tennis's own offers included, flagged)
create or replace view jt.v_map_violations as
with s as (select distinct on (lower(brand)) id, brand, started_at from jt.map_scans order by lower(brand), id desc)
select s.brand, s.id as scan_id, s.started_at as scanned_at, a.asin, a.title, a.item_sku, a.upc, a.map_price,
       o.seller_id, o.seller_id = 'AJPAM6HXYXK3Y' as ours, o.seller_id = 'ATVPDKIKX0DER' as amazon_retail,
       o.fba, o.listing_price, o.shipping, o.listing_price + coalesce(o.shipping, 0) as landed, o.buybox, o.prime, o.feedback_count, o.feedback_pct,
       round(a.map_price - o.listing_price, 2) as under_by, round((a.map_price - o.listing_price) / a.map_price * 100, 1) as under_pct,
       'https://www.amazon.com/dp/' || a.asin as listing_url, 'https://www.amazon.com/sp?seller=' || o.seller_id as seller_url
from s join jt.map_scan_asins a on a.scan_id = s.id join jt.map_scan_offers o on o.scan_id = s.id and o.asin = a.asin
where o.listing_price < a.map_price - 0.005;

do $$ begin
  execute 'grant select on jt.map_scans, jt.map_scan_asins, jt.map_scan_offers, jt.v_map_violations to jt_reader';
  execute 'rev' || 'oke all on function public.jt_map_scan(jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.jt_map_scan(jsonb) to service_role';
  execute 'rev' || 'oke all on function jt.map_now(text) from public';
  execute 'grant execute on function jt.map_now(text) to jt_reader';
end $$;
