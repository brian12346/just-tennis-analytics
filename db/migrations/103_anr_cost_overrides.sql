-- Ace n Rally: enter a cost for an order whose items have no Just Tennis cost (custom items, unmatched used rackets),
-- like the Just Tennis tab's "Enter cost" (Brian, Oct 7). The entered cost is the cost of the order's uncosted items;
-- it's spread over them, and they stop counting as "no cost". Clearing it (cost null) puts them back.
-- Gross profit in All sales leaves out sales with no cost on both Shopify stores (as Shopify reports it), so a missing
-- cost never shows as 100% margin.

create table if not exists jt.anr_cost_overrides (
  order_id    bigint primary key,
  order_name  text not null default '',
  cost        numeric check (cost >= 0),            -- null = cleared
  note        text not null default '',
  by_user     text not null default '',
  updated_at  timestamptz not null default now()
);

-- p = {order_id, order_name, cost ('' or null clears), note, by}
create or replace function jt.save_anr_cost(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from jt.anr_sales where order_id = (p->>'order_id')::bigint) then raise exception 'unknown Ace n Rally order %', p->>'order_id'; end if;
  insert into jt.anr_cost_overrides (order_id, order_name, cost, note, by_user)
  values ((p->>'order_id')::bigint, coalesce(p->>'order_name', ''), nullif(p->>'cost', '')::numeric, coalesce(p->>'note', ''), coalesce(p->>'by', ''))
  on conflict (order_id) do update set order_name = excluded.order_name, cost = excluded.cost, note = excluded.note,
    by_user = excluded.by_user, updated_at = now();
  return true;
end $$;
revoke all on function jt.save_anr_cost(jsonb) from public;
create or replace function public.jt_save_anr_cost(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.save_anr_cost(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_save_anr_cost(jsonb) from public, anon;
grant execute on function public.jt_save_anr_cost(jsonb) to authenticated;

-- Ace n Rally sales lines with entered costs applied
create or replace view jt.v_anr_sales_final as
with o as (select order_id, sum(net_no_cost) as nc from jt.v_anr_sales_costed where order_id <> 0 group by order_id)
select s.day, s.order_id, s.order_name, s.variant_id, s.product_id, s.product_title, s.variant_title, s.sku, s.product_type, s.vendor,
       s.sales_channel, s.units, s.gross, s.discounts, s.returns, s.net,
       s.cogs + case when ov.cost is not null and abs(o.nc) >= 0.01 then round(ov.cost * s.net_no_cost / o.nc, 2) else 0 end as cogs,
       case when ov.cost is not null and abs(o.nc) >= 0.01 then 0 else s.net_no_cost end as net_no_cost,
       s.jt_variant_id, s.match_how, ov.cost is not null and abs(o.nc) >= 0.01 as cost_entered
from jt.v_anr_sales_costed s
left join o on o.order_id = s.order_id
left join jt.anr_cost_overrides ov on ov.order_id = s.order_id;

-- Ace n Rally days with entered costs applied (the Ace n Rally tab)
create or replace view jt.v_anr_daily_final as
with l as (select day, sum(cogs) as cogs, sum(net_no_cost) as net_no_cost from jt.v_anr_sales_final group by day)
select a.day, a.orders, a.gross, a.discounts, a.returns, a.net, a.shipping, a.taxes, a.total,
       coalesce(l.cogs, a.cogs) as cogs, a.net - coalesce(l.net_no_cost, a.net_no_cost) - coalesce(l.cogs, a.cogs) as gross_profit,
       coalesce(l.net_no_cost, a.net_no_cost) as net_no_cost, a.synced_at
from jt.v_anr_daily_costed a left join l on l.day = a.day;

-- Ace n Rally orders with items that have no cost, and any cost entered for them
create or replace view jt.v_anr_orders_nocost as
select s.order_id, max(s.order_name) as order_name, min(s.day) as day, sum(s.net) as net, sum(s.net_no_cost) as net_no_cost,
       string_agg(coalesce(nullif(s.product_title, ''), 'Custom item') || case when s.units <> 1 then ' ×' || trim(to_char(s.units, 'FM999999')) else '' end, ', ' order by s.net desc)
         filter (where abs(s.net_no_cost) >= 0.01) as items,
       max(ov.cost) as cost, max(ov.note) as note, max(ov.by_user) as cost_by
from jt.v_anr_sales_costed s left join jt.anr_cost_overrides ov on ov.order_id = s.order_id
where s.order_id <> 0
group by s.order_id
having abs(sum(s.net_no_cost)) >= 0.01;

create or replace view jt.v_sales_channels_daily as
with anr_orders as (select distinct order_id from jt.anr_sales where order_id <> 0),
jt_labels as (
  select coalesce(o.order_day, l.ship_date) as day, sum(l.cost) as cost
  from jt.shipstation_labels l left join jt.shopify_orders o on o.order_id = l.order_id
  where not l.voided and (l.order_id is null or l.order_id not in (select order_id from anr_orders))
  group by 1),
anr_labels as (select order_day as day, sum(label_cost) as cost from jt.v_anr_order_shipping group by 1),
veeqo as (select (v.order_created_at at time zone 'America/Los_Angeles')::date as day, sum(v.cost) as cost
          from jt.veeqo_shipments v where v.cost is not null and v.amazon_order_id <> '' group by 1),
units_jt as (select day, sum(units) as units, sum(cogs) as cogs, sum(net_no_cost) as net_no_cost from jt.v_product_sales_daily_costed group by day),
units_anr as (select day, sum(units) as units, sum(cogs) as cogs, sum(net_no_cost) as net_no_cost from jt.v_anr_sales_final group by day),
pay as (select store, day, sum(fee) as fee from jt.v_shopify_payment_fees group by 1, 2)
select s.day, 'justtennis'::text as channel, s.orders::numeric as orders, coalesce(u.units, 0) as units, s.net as net_sales,
       coalesce(u.cogs, s.cogs) as cogs, s.net - coalesce(u.net_no_cost, s.net_no_cost) - coalesce(u.cogs, s.cogs) as gross_profit,
       coalesce(u.net_no_cost, s.net_no_cost) as sales_no_cost,
       s.shipping as ship_charged, coalesce(l.cost, 0) as labels, 0::numeric as amz_fees, 0::numeric as fba_fees, 0::numeric as other_fees,
       s.net - coalesce(u.net_no_cost, s.net_no_cost) - coalesce(u.cogs, s.cogs) + s.shipping - coalesce(l.cost, 0) - coalesce(p.fee, 0) as profit,
       coalesce(p.fee, 0) as pay_fees
from jt.v_shopify_daily_costed s left join units_jt u on u.day = s.day left join jt_labels l on l.day = s.day
left join pay p on p.store = 'justtennis' and p.day = s.day
union all
select a.day, 'acenrally', a.orders::numeric, coalesce(u.units, 0), a.net, coalesce(u.cogs, a.cogs),
       a.net - coalesce(u.net_no_cost, a.net_no_cost) - coalesce(u.cogs, a.cogs), coalesce(u.net_no_cost, a.net_no_cost),
       a.shipping, coalesce(l.cost, 0), 0, 0, 0,
       a.net - coalesce(u.net_no_cost, a.net_no_cost) - coalesce(u.cogs, a.cogs) + a.shipping - coalesce(l.cost, 0) - coalesce(p.fee, 0), coalesce(p.fee, 0)
from jt.v_anr_daily_costed a left join units_anr u on u.day = a.day left join anr_labels l on l.day = a.day
left join pay p on p.store = 'acenrally' and p.day = a.day
union all
select a.day, 'amazon', a.orders, a.units, a.sales, coalesce(c.cogs, 0), a.sales - coalesce(c.cogs, 0), coalesce(c.no_cost, 0),
       a.ship, -a.other_labels + coalesce(v.cost, 0), -a.sellfees, -a.fbafees, -(a.promo + a.refunds_net + a.other_rest),
       a.orders_net + a.refunds_net + a.other_labels + a.other_rest - coalesce(c.cogs, 0) - coalesce(v.cost, 0), 0::numeric
from jt.amazon_order_daily a
left join lateral (select sum(k.units * m.cost) as cogs, sum(case when m.cost is null then k.sales else 0 end) as no_cost
                   from jt.amazon_sku_daily k left join jt.mv_amz_sku_cost m on m.sku = k.sku where k.day = a.day) c on true
left join veeqo v on v.day = a.day;

create or replace view jt.v_sales_products_daily as
select day, 'justtennis'::text as channel, product_id, product_title as title, vendor, product_type, units, net as net_sales, cogs, gross_profit,
       0::numeric as amz_fees
from jt.v_product_sales_daily_costed
union all
select s.day, 'acenrally', coalesce(v.product_id, s.product_id), coalesce(nullif(v.product_title, ''), s.product_title), coalesce(nullif(v.vendor, ''), s.vendor),
       coalesce(nullif(v.product_type, ''), s.product_type), s.units, s.net, s.cogs, s.net - s.cogs, 0
from jt.v_anr_sales_final s left join jt.variants v on v.variant_id = s.jt_variant_id
union all
select k.day, 'amazon', v.product_id, coalesce(nullif(v.product_title, ''), k.sku), coalesce(v.vendor, ''), coalesce(v.product_type, ''),
       k.units * coalesce(m.map_units, 1), k.sales, coalesce(k.units * m.cost, 0), k.sales - coalesce(k.units * m.cost, 0), k.sales - k.net
from jt.amazon_sku_daily k left join jt.mv_amz_sku_cost m on m.sku = k.sku left join jt.variants v on v.variant_id = m.variant_id
where k.lines > 0;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.anr_cost_overrides, jt.v_anr_sales_final, jt.v_anr_daily_final, jt.v_anr_orders_nocost,
      jt.v_sales_channels_daily, jt.v_sales_products_daily to jt_reader;
  end if;
end $$;
