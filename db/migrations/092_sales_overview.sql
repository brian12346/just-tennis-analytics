-- Sales overview (Product sales tab, Oct 2026): Just Tennis (Shopify), Ace n Rally (Shopify) and Amazon (US + MX) in
-- one place — net sales, orders, units and gross profit per channel per day, and products across all three.
--
-- Amazon comes from the order-date day documents (jt.docs 'amzodays', migration 084: fees & refunds by order date,
-- unshipped orders estimated). Reading their order lines straight from jsonb is slow over long ranges, so each
-- day's lines are kept per seller SKU in jt.amazon_sku_daily (filled by a trigger whenever a day document is saved).
-- Amazon cost = the mapped Shopify variant's unit cost × units per Amazon unit (or the mapping's manual cost), the
-- same rule the Amazon tab uses.

create table if not exists jt.amazon_sku_daily (
  day     date not null,
  sku     text not null,
  lines   integer not null default 0,
  units   numeric not null default 0,
  sales   numeric not null default 0,   -- item price (product sales)
  net     numeric not null default 0,   -- after Amazon fees, promos and shipping credits
  primary key (day, sku)
);

-- the day's totals (one row per day)
create table if not exists jt.amazon_order_daily (
  day         date primary key,
  orders      numeric not null default 0,
  units       numeric not null default 0,
  sales       numeric not null default 0,
  orders_net  numeric not null default 0,
  refunds_net numeric not null default 0
);

create or replace function jt.amazon_sku_daily_fill(p_day date, p_data jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; k text[]; ord jsonb := coalesce(p_data->'orders', '[]'::jsonb); t jsonb := coalesce(p_data->'totals', '{}'::jsonb);
begin
  k := array(select jsonb_array_elements_text(coalesce(p_data->'skus', '[]'::jsonb)));   -- once: indexing the jsonb per line is slow
  -- SKUs no longer in the day go to zero (no bare deletes through the API's pg-safeupdate), the rest are upserted
  update jt.amazon_sku_daily set lines = 0, units = 0, sales = 0, net = 0 where day = p_day and lines <> 0;
  insert into jt.amazon_sku_daily as t (day, sku, lines, units, sales, net)
  select p_day, coalesce(k[(o->>2)::int + 1], '?'), count(*), sum((o->>3)::numeric), sum((o->>4)::numeric), sum((o->>9)::numeric)
  from jsonb_array_elements(ord) o
  group by 2
  on conflict (day, sku) do update set lines = excluded.lines, units = excluded.units, sales = excluded.sales, net = excluded.net;
  get diagnostics n = row_count;
  insert into jt.amazon_order_daily (day, orders, units, sales, orders_net, refunds_net)
  values (p_day, coalesce((t->>'orders')::numeric, 0), coalesce((t->>'units')::numeric, 0), coalesce((t->>'sales')::numeric, 0),
          coalesce((t->>'orders_net')::numeric, 0), coalesce((t->>'refunds_net')::numeric, 0))
  on conflict (day) do update set orders = excluded.orders, units = excluded.units, sales = excluded.sales,
    orders_net = excluded.orders_net, refunds_net = excluded.refunds_net;
  return n;
end $$;
revoke all on function jt.amazon_sku_daily_fill(date, jsonb) from public;

create or replace function jt.docs_amzodays_trg() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.collection = 'amzodays' and new.id ~ '^\d{4}-\d{2}-\d{2}$' then
    perform jt.amazon_sku_daily_fill(new.id::date, new.data);
  end if;
  return null;
end $$;
create or replace trigger docs_amzodays after insert or update of data on jt.docs
  for each row when (new.collection = 'amzodays') execute function jt.docs_amzodays_trg();

do $$ declare d record; begin
  for d in select id, data from jt.docs where collection = 'amzodays' and id ~ '^\d{4}-\d{2}-\d{2}$' loop
    perform jt.amazon_sku_daily_fill(d.id::date, d.data);
  end loop;
end $$;

-- seller SKU -> Shopify variant and cost per Amazon unit
create or replace view jt.v_amz_sku_cost as
select d.data->>'sku' as sku,
       case when d.data->>'kind' = 'shopify' then v.variant_id end as variant_id,
       coalesce(nullif(d.data->>'units', '')::numeric, 1) as map_units,
       case when d.data->>'kind' = 'manual' then nullif(d.data->>'manualCost', '')::numeric
            when d.data->>'kind' = 'shopify' then coalesce(v.unit_cost, nullif(d.data->>'unitCost', '')::numeric) * coalesce(nullif(d.data->>'units', '')::numeric, 1)
       end as cost
from jt.docs d
left join jt.variants v on d.data->>'kind' = 'shopify' and v.variant_id = nullif((regexp_match(d.data->>'variantId', '(\d+)$'))[1], '')::bigint
where d.collection = 'amzmap' and coalesce(d.data->>'sku', '') <> '';

-- one row per day and channel: justtennis | acenrally | amazon
create or replace view jt.v_sales_channels_daily as
select s.day, 'justtennis'::text as channel, s.orders::numeric as orders, coalesce(u.units, 0) as units, s.net as net_sales,
       s.cogs, s.gross_profit, s.net_no_cost as sales_no_cost
from jt.v_shopify_daily_costed s
left join (select day, sum(units) as units from jt.v_product_sales_daily_costed group by day) u on u.day = s.day
union all
select a.day, 'acenrally', a.orders::numeric, coalesce(u.units, 0), a.net, a.cogs, a.gross_profit, a.net_no_cost
from jt.v_anr_daily_costed a
left join (select day, sum(units) as units from jt.v_anr_sales_costed group by day) u on u.day = a.day
union all
select a.day, 'amazon', a.orders, a.units, a.sales, coalesce(c.cogs, 0), a.orders_net + a.refunds_net - coalesce(c.cogs, 0), coalesce(c.no_cost, 0)
from jt.amazon_order_daily a
left join (select k.day, sum(k.units * m.cost) as cogs, sum(case when m.cost is null then k.sales else 0 end) as no_cost
           from jt.amazon_sku_daily k left join jt.v_amz_sku_cost m on m.sku = k.sku group by k.day) c on c.day = a.day;

-- products across the channels, by Just Tennis product (Ace n Rally through its Just Tennis match, Amazon through
-- the SKU mapping; unmatched lines keep their own name with product_id null). units are Shopify units.
create or replace view jt.v_sales_products_daily as
select day, 'justtennis'::text as channel, product_id, product_title as title, vendor, product_type, units, net as net_sales, cogs, gross_profit
from jt.v_product_sales_daily_costed
union all
select s.day, 'acenrally', coalesce(v.product_id, s.product_id), coalesce(nullif(v.product_title, ''), s.product_title), coalesce(nullif(v.vendor, ''), s.vendor),
       coalesce(nullif(v.product_type, ''), s.product_type), s.units, s.net, s.cogs, s.net - s.cogs
from jt.v_anr_sales_costed s left join jt.variants v on v.variant_id = s.jt_variant_id
union all
select k.day, 'amazon', v.product_id, coalesce(nullif(v.product_title, ''), k.sku), coalesce(v.vendor, ''), coalesce(v.product_type, ''),
       k.units * coalesce(m.map_units, 1), k.sales, coalesce(k.units * m.cost, 0), k.net - coalesce(k.units * m.cost, 0)
from jt.amazon_sku_daily k left join jt.v_amz_sku_cost m on m.sku = k.sku left join jt.variants v on v.variant_id = m.variant_id
where k.lines > 0;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.amazon_sku_daily, jt.amazon_order_daily, jt.v_amz_sku_cost, jt.v_sales_channels_daily, jt.v_sales_products_daily to jt_reader;
  end if;
end $$;
