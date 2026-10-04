-- Ace n Rally (acenrally.com): Brian's second Shopify store. Sales only — it sells Just Tennis's products, and all
-- receiving and costs are done in Just Tennis. So Ace n Rally's sales are costed with the Just Tennis product they
-- match (same SKU, else same barcode, else a mapping set by hand) at that product's Just Tennis cost.
-- Loaded by the sync's acenrally jobs (hourly 3 days, nightly 35 days, catalog nightly) with the same Shopify
-- Analytics queries as Just Tennis.

-- Daily store totals and sales facts, the same shape as jt.shopify_daily / jt.shopify_sales.
create table if not exists jt.anr_daily (like jt.shopify_daily including all);
create table if not exists jt.anr_sales (like jt.shopify_sales including all);
create index if not exists anr_sales_variant_idx on jt.anr_sales (variant_id);
create index if not exists anr_sales_sku_idx on jt.anr_sales (lower(trim(sku)));

-- Ace n Rally's catalog (for matching by barcode, and products not sold yet).
create table if not exists jt.anr_variants (
  variant_id     bigint primary key,
  product_id     bigint not null default 0,
  sku            text not null default '',
  barcode        text not null default '',
  product_title  text not null default '',
  variant_title  text not null default '',
  display_name   text not null default '',
  vendor         text not null default '',
  product_type   text not null default '',
  status         text not null default '',
  price          numeric(12,2),
  seen_at        timestamptz not null default now()
);

-- Matches set by hand (an Ace n Rally variant whose SKU / barcode doesn't find its Just Tennis product).
create table if not exists jt.anr_map (
  anr_variant_id bigint primary key,
  jt_variant_id  bigint not null,
  units          numeric(12,3) not null default 1,   -- Just Tennis units per Ace n Rally unit (packs)
  by_user        text not null default '',
  updated_at     timestamptz not null default now()
);

-- Every Ace n Rally variant (catalog or sales) with the Just Tennis variant it costs as.
create or replace view jt.v_anr_variant_map as
with a as (
  select variant_id, sku, barcode, coalesce(nullif(display_name, ''), product_title) as title from jt.anr_variants
  union all
  select * from (
    select distinct on (variant_id) variant_id, sku, '' as barcode, product_title || case when variant_title <> '' then ' - ' || variant_title else '' end as title
    from jt.anr_sales where variant_id <> 0 and variant_id not in (select variant_id from jt.anr_variants)
    order by variant_id, day desc
  ) x
),
jsku as (   -- one Just Tennis variant per SKU (active first)
  select distinct on (lower(trim(sku))) lower(trim(sku)) as k, variant_id from jt.variants
  where trim(sku) <> '' and removed_at is null order by lower(trim(sku)), (status = 'active') desc, seen_at desc
),
jbar as (
  select distinct on (ltrim(trim(barcode), '0')) ltrim(trim(barcode), '0') as k, variant_id from jt.variants
  where ltrim(trim(coalesce(barcode, '')), '0') <> '' and removed_at is null order by ltrim(trim(barcode), '0'), (status = 'active') desc, seen_at desc
)
select a.variant_id as anr_variant_id, a.sku, a.barcode, a.title,
       coalesce(m.jt_variant_id, s.variant_id, b.variant_id) as jt_variant_id,
       coalesce(m.units, 1) as units,
       case when m.jt_variant_id is not null then 'manual' when s.variant_id is not null then 'sku' when b.variant_id is not null then 'barcode' else '' end as how
from a
left join jt.anr_map m on m.anr_variant_id = a.variant_id
left join jsku s on s.k = lower(trim(a.sku)) and a.sku <> ''
left join jbar b on b.k = ltrim(trim(a.barcode), '0') and ltrim(trim(a.barcode), '0') <> '';

-- Sales costed at today's Just Tennis cost (the dashboard's "Costs: current" basis). Custom items and unmatched
-- products keep what Shopify recorded and count as "no cost".
create or replace view jt.v_anr_sales_costed as
select s.day, s.order_id, s.order_name, s.variant_id, s.product_id, s.product_title, s.variant_title, s.sku, s.product_type,
       s.vendor, s.sales_channel, s.units, s.gross, s.discounts, s.returns, s.net,
       case when v.unit_cost is not null then round(s.units * m.units * v.unit_cost, 2) else s.cogs end as cogs,
       case when v.unit_cost is not null then 0 else s.net end as net_no_cost,
       s.cogs as cogs_recorded, s.net_no_cost as net_no_cost_recorded, m.jt_variant_id, m.how as match_how
from jt.anr_sales s
left join jt.v_anr_variant_map m on m.anr_variant_id = s.variant_id and s.variant_id <> 0
left join jt.variants v on v.variant_id = m.jt_variant_id and v.unit_cost > 0;

-- daily totals re-costed the same way as jt.v_shopify_daily_costed (Shopify's figures, adjusted by the cost difference)
create or replace view jt.v_anr_daily_costed as
with d as (
  select day, sum(cogs - cogs_recorded) as dcogs, sum(net_no_cost_recorded - net_no_cost) as dnc
  from jt.v_anr_sales_costed group by day
)
select s.day, s.orders, s.gross, s.discounts, s.returns, s.net, s.shipping, s.taxes, s.total,
       round(s.cogs + coalesce(d.dcogs, 0), 2)          as cogs,
       round(s.gross_profit - coalesce(d.dcogs, 0) + coalesce(d.dnc, 0), 2) as gross_profit,
       round(s.net_no_cost - coalesce(d.dnc, 0), 2)     as net_no_cost,
       s.synced_at
from jt.anr_daily s
left join d using (day);

-- Fix in Just Tennis's re-costed daily view (migration 010): Shopify's gross profit leaves out sales with no cost
-- recorded, so a sale that gets a cost now must add its net sales as well as its cost. Before this, gross profit
-- under "Costs: current" came out low by the net sales of those items (about $560–1,400 a month in Jun–Sep 2026).
create or replace view jt.v_shopify_daily_costed as
with d as (
  select day, sum(cogs - cogs_recorded) as dcogs, sum(net_no_cost_recorded - net_no_cost) as dnc
  from jt.v_shopify_sales_costed group by day
)
select s.day, s.orders, s.gross, s.discounts, s.returns, s.net, s.shipping, s.taxes, s.total,
       round(s.cogs + coalesce(d.dcogs, 0), 2)          as cogs,
       round(s.gross_profit - coalesce(d.dcogs, 0) + coalesce(d.dnc, 0), 2) as gross_profit,
       round(s.net_no_cost - coalesce(d.dnc, 0), 2)     as net_no_cost,
       s.synced_at
from jt.shopify_daily s
left join d using (day);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.anr_daily, jt.anr_sales, jt.anr_variants, jt.anr_map, jt.v_anr_variant_map, jt.v_anr_sales_costed, jt.v_anr_daily_costed to jt_reader;
  end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then
    grant select on jt.anr_daily, jt.anr_sales, jt.v_anr_sales_costed, jt.v_anr_daily_costed to fin_reader;
  end if;
end $$;
