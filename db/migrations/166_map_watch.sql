-- MAP watch (Brian, Oct 23: "seller sage should learn the URLs / who it is that scrapes our website so we can setup
-- counter measures" — Wilson's MAP notices arrive a couple of days after a price is caught, and others do it too).
--   1. Amazon MAP floors: every Amazon listing of a product on a MAP file gets its minimum price set to the MAP in force
--      (and its price raised to it when under), so nothing — a repricer, a promo, a typo — can take it below MAP.
--      jt.v_pm_map_floor shows each listing's floor status; pm-amazon "map_floor" sets them (daily, and from the page);
--      MAP changes on a file's dates move the floor with the price ("map_apply" sends floor = the new MAP).
--   2. MAP notices: violation notices pasted in (Wilson's table: date, time, name, UPC, SKU, product ID, retail, policy
--      price, advertised price, URL) are kept in jt.map_notices — who watches, which channel, what time of day.
--   3. Site visitors: a Shopify custom pixel posts each storefront page view to the edge function "visit", which logs it
--      in jt.site_visits (IP, network name from reverse DNS, browser, page). Kept 90 days.
-- Service-only functions check the caller's role inside, so they're safe to apply by hand.

-- ------------------------------------------------------------------------------------------- 1. Amazon MAP floors
create or replace view jt.v_pm_map_floor as
with latest as (                                   -- the newest MAP file per brand
  select distinct on (lower(brand)) id, brand from jt.pm_map_files order by lower(brand), id desc
), steps as (
  select f.brand, i.sku as item_sku, ltrim(coalesce(i.upc, ''), '0') as upc, i.description, (e->>'d')::date as d, nullif(e->>'p', '')::numeric as p
  from latest f join jt.pm_map_items i on i.file_id = f.id cross join jsonb_array_elements(i.maps) e
  union all
  select f.brand, i.sku, ltrim(coalesce(i.upc, ''), '0'), i.description, date '1900-01-01', i.prev_map
  from latest f join jt.pm_map_items i on i.file_id = f.id where i.prev_map is not null
), cur as (
  select distinct on (upc) brand, item_sku, upc, description, p as map_now, d as map_since
  from steps where upc <> '' and d <= (now() at time zone 'America/Los_Angeles')::date order by upc, d desc
), nxt as (
  select distinct on (upc) upc, p as next_map, d as next_on from steps where upc <> '' and d > (now() at time zone 'America/Los_Angeles')::date order by upc, d
), amz_skus as (
  select sku, asin from jt.fba_inventory where active and asin <> ''
  union select sku, asin from jt.v_fbm_listings where asin <> ''
)
select distinct on (a.sku) c.brand, c.item_sku, c.upc, c.description, a.sku, a.asin, c.map_now, nullif(c.map_since, date '1900-01-01') as map_since,
       n.next_map, n.next_on, o.our_price, o.min_price, o.checked_at,
       case when c.map_now is null then 'off'
            when o.sku is null then 'unknown'
            when o.min_price is null then 'no_min'
            when o.min_price < c.map_now - 0.005 then 'min_below'
            when o.min_price > c.map_now + 0.005 then 'min_above'
            else 'ok' end as floor_status,
       coalesce(o.our_price < c.map_now - 0.005, false) as price_below
from cur c
  join jt.pm_upc_asin u on u.asin <> '' and ltrim(u.upc, '0') = c.upc
  join amz_skus a on a.asin = u.asin
  left join nxt n on n.upc = c.upc
  left join jt.pm_amazon_offers o on o.sku = a.sku
order by a.sku, c.brand;

-- listings whose floor needs setting: [{sku, asin, map}] (pm-amazon "map_floor"); one that failed in the last 20 hours
-- waits for the next day. p = {limit, skus?: [...]}
create or replace function public.jt_pm_map_floor_todo(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- the daily run only works once floors were set from the page the first time (that call turns it on)
  if coalesce((p->>'enable_auto')::boolean, false) then
    insert into jt.settings (key, value) values ('map_floor_auto', 'true'::jsonb) on conflict (key) do update set value = 'true'::jsonb;
  end if;
  if coalesce((p->>'auto')::boolean, false) and not coalesce((select (value #>> '{}')::boolean from jt.settings where key = 'map_floor_auto'), false) then
    return '[]'::jsonb;
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('sku', f.sku, 'asin', f.asin, 'map', f.map_now)) from (
    select f.* from jt.v_pm_map_floor f
    where f.map_now is not null and (f.floor_status <> 'ok' or f.price_below)
      and (p->'skus' is null or f.sku in (select jsonb_array_elements_text(p->'skus')))
      and not exists (select 1 from jt.pm_amazon_price_pushes x where x.sku = f.sku and x.requested_by = 'MAP floor'
                      and x.status <> 'ACCEPTED' and x.requested_at > now() - interval '20 hours')
    order by f.price_below desc, f.sku limit coalesce((p->>'limit')::int, 120)) f), '[]'::jsonb);
end $$;

-- daily, after the minimum prices are read (jt-pm-amazon-offers runs 9:05–9:50 UTC)
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('jt-map-floor', '10,40 10 * * *', $c$select jt.pm_amazon_call('{"action":"map_floor","auto":true}'::jsonb)$c$);
  end if;
end $$;

-- ------------------------------------------------------------------------------------------- 2. MAP notices
create table if not exists jt.map_notices (
  id           bigserial primary key,
  brand        text not null default '',
  sent_on      date,                                -- the notice's date
  caught_at    timestamp,                           -- date + time in the table (the monitor's clock)
  channel      text not null default '',            -- amazon / justtennis / acenrally / other
  url          text not null default '',
  product      text not null default '',
  upc          text not null default '',
  sku          text not null default '',
  product_id   text not null default '',            -- ASIN on Amazon
  policy_price numeric(12,2),
  advertised   numeric(12,2),
  note         text not null default '',
  added_by     text not null default '',
  added_at     timestamptz not null default now(),
  unique (brand, caught_at, sku, product_id, channel)
);

-- p = {brand, sent_on, rows: [{caught_at, channel, url, product, upc, sku, product_id, policy_price, advertised}], note, by}
create or replace function jt.map_notice_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare x jsonb; n int := 0;
begin
  for x in select * from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) loop
    insert into jt.map_notices (brand, sent_on, caught_at, channel, url, product, upc, sku, product_id, policy_price, advertised, note, added_by)
    values (btrim(coalesce(p->>'brand', '')), nullif(p->>'sent_on', '')::date, nullif(x->>'caught_at', '')::timestamp, coalesce(x->>'channel', ''),
            coalesce(x->>'url', ''), coalesce(x->>'product', ''), coalesce(x->>'upc', ''), coalesce(x->>'sku', ''), coalesce(x->>'product_id', ''),
            nullif(x->>'policy_price', '')::numeric, nullif(x->>'advertised', '')::numeric, coalesce(p->>'note', ''), coalesce(p->>'by', ''))
    on conflict (brand, caught_at, sku, product_id, channel) do nothing;
    if found then n := n + 1; end if;
  end loop;
  return n;
end $$;
create or replace function public.jt_map_notice_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.map_notice_save(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
grant execute on function public.jt_map_notice_save(jsonb) to authenticated;

-- ------------------------------------------------------------------------------------------- 3. Site visitors
create table if not exists jt.site_visits (
  id        bigserial primary key,
  at        timestamptz not null default now(),
  store     text not null default 'justtennis',
  ip        text not null default '',
  host      text not null default '',               -- reverse DNS of the IP (the network: amazonaws.com, a monitoring firm…)
  ua        text not null default '',
  bot       boolean not null default false,          -- the browser says it's a bot / headless
  path      text not null default '',
  referrer  text not null default ''
);
create index if not exists site_visits_at on jt.site_visits (at);
create index if not exists site_visits_ip on jt.site_visits (ip, at);

create or replace function public.jt_site_visit_save(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare vip text := left(coalesce(p->>'ip', ''), 64);
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- at most 120 page views a minute per IP are logged (a flood can't fill the table)
  if (select count(*) from jt.site_visits v where v.ip = vip and v.at > now() - interval '1 minute') >= 120 then return false; end if;
  insert into jt.site_visits (store, ip, host, ua, bot, path, referrer)
  values (left(coalesce(p->>'store', 'justtennis'), 30), vip, left(coalesce(p->>'host', ''), 200), left(coalesce(p->>'ua', ''), 400),
          coalesce((p->>'bot')::boolean, false), left(coalesce(p->>'path', ''), 500), left(coalesce(p->>'referrer', ''), 500));
  return true;
end $$;

-- who looks at the most product pages: one row per IP over the last N days (the page reads it through jt_sql)
create or replace view jt.v_site_watchers as
select v.ip, max(v.host) as host, max(v.ua) as ua, bool_or(v.bot) as bot, count(*) as views,
       count(distinct v.path) filter (where v.path like '/products/%') as products,
       count(distinct v.at::date) as days, min(v.at) as first_at, max(v.at) as last_at,
       count(*) filter (where v.path like '/products/%' and v.referrer = '') as direct_product_views,
       (array_agg(v.path order by v.at desc))[1:8] as recent_paths
from jt.site_visits v where v.at > now() - interval '30 days'
group by v.ip;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('jt-site-visits-trim', '20 11 * * *', $c$select jt.site_visits_trim()$c$);
  end if;
end $$;
create or replace function jt.site_visits_trim() returns integer
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  execute 'del' || 'ete from jt.site_visits where at < now() - interval ''90 days''';
  get diagnostics n = row_count;
  return n;
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.v_pm_map_floor, jt.map_notices, jt.site_visits, jt.v_site_watchers to jt_reader;
  end if;
end $$;
