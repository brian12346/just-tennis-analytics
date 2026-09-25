-- Just Tennis analytics: reporting views and the functions the dashboard calls to save edits.

-- ---------------------------------------------------------------- product cost rules
-- Cost of a variant on a given day.
-- Today's Shopify cost applies to all history, except where a cost change counts as "real":
-- then sales before that change keep the old cost. A change is real when marked 'real', or
-- when unmarked and made on/after settings.costs.history_start (earlier edits were corrections).
-- The daily catalog check runs the morning after the edit, so a change takes effect the day after changed_on.
create or replace function jt.variant_cost_on(v bigint, d date) returns numeric
language sql stable as $$
  with cfg as (
    select (value->>'history_start')::date as hs from jt.settings where key = 'costs'
  ), real_changes as (
    select c.changed_on, c.old_cost
    from jt.variant_cost_changes c
    left join cfg on true
    where c.variant_id = v
      and c.changed_on + 1 > d
      and coalesce(c.kind, case when cfg.hs is not null and c.changed_on >= cfg.hs then 'real' else 'correction' end) = 'real'
    order by c.changed_on
    limit 1
  )
  select coalesce((select old_cost from real_changes), (select unit_cost from jt.variants where variant_id = v));
$$;

-- ---------------------------------------------------------------- Shopify
-- Order totals over all synced history.
create or replace view jt.v_order_sales as
select order_id,
       max(order_name)                 as order_name,
       min(day)                        as first_day,
       sum(units)                      as units,
       sum(net)                        as net,
       sum(cogs)                       as cogs,
       sum(net_no_cost)                as net_no_cost
from jt.shopify_sales
group by order_id;

-- Every sales row with saved costs applied, on the day Shopify recorded it:
--  * order with a saved cost: its no-cost sales are covered, and the cost you added is spread over those
--    rows in proportion (a later return takes its share back);
--  * order whose no-cost items were all returned (nets to zero): nothing to cost, so not flagged.
create or replace view jt.v_sales_adjusted as
select s.*,
       (ov.order_id is not null) as has_override,
       case when ov.order_id is not null or abs(o.net_no_cost) < 0.01 then 0 else s.net_no_cost end as net_no_cost_adj,
       case when ov.order_id is not null and abs(o.net_no_cost) >= 0.01
            then (ov.cost - coalesce(ov.shopify_cogs, o.cogs)) * s.net_no_cost / o.net_no_cost
            else 0 end as cost_added
from jt.shopify_sales s
join jt.v_order_sales o using (order_id)
left join jt.cost_overrides ov using (order_id);

-- Label cost counted on the order's day when the label matches a Shopify order, else on the ship date.
create or replace view jt.v_label_cost_daily as
select coalesce(o.order_day, l.ship_date) as day,
       count(*)                            as labels,
       count(distinct l.order_id)          as orders_with_labels,
       sum(l.cost)                         as label_cost
from jt.shipstation_labels l
left join jt.shopify_orders o on o.order_id = l.order_id
where not l.voided
group by 1;

create or replace view jt.v_daily as
with adj as (
  select day,
         sum(cost_added)                        as cost_added,
         sum(net_no_cost - net_no_cost_adj)     as no_cost_covered
  from jt.v_sales_adjusted
  group by day
)
select d.day, d.orders, d.gross, d.discounts, d.returns, d.net, d.shipping, d.taxes, d.total,
       d.cogs                                                   as cogs_shopify,
       round(d.cogs + coalesce(a.cost_added, 0), 2)             as cogs,
       round(d.gross_profit - coalesce(a.cost_added, 0), 2)     as gross_profit,
       d.net_no_cost                                            as net_no_cost_shopify,
       round(d.net_no_cost - coalesce(a.no_cost_covered, 0), 2) as net_no_cost,
       coalesce(lc.labels, 0)                                   as labels,
       coalesce(lc.label_cost, 0)                               as label_cost,
       round(d.gross_profit - coalesce(a.cost_added, 0) + d.shipping - coalesce(lc.label_cost, 0), 2) as profit_after_shipping
from jt.shopify_daily d
left join adj a using (day)
left join jt.v_label_cost_daily lc using (day);

create or replace view jt.v_order_profit as
with s as (
  select order_id,
         sum(net)                     as net,
         sum(cogs + cost_added)       as cogs,
         sum(net_no_cost_adj)         as net_no_cost,
         bool_or(has_override)        as has_override
  from jt.v_sales_adjusted group by order_id
), l as (
  select order_id, count(*) as labels, sum(cost) as label_cost, string_agg(distinct service, '; ') as services
  from jt.shipstation_labels where not voided and order_id is not null group by order_id
)
select o.order_id, o.name, o.created_at, o.order_day, o.channel, o.source_name, o.financial_status,
       o.fulfillment_status, o.cancelled_at, o.subtotal, o.discounts, o.shipping, o.tax, o.total, o.refunded,
       coalesce(s.net, 0)                          as net,
       round(coalesce(s.cogs, 0), 2)               as cogs,
       round(coalesce(s.net - s.cogs, 0), 2)       as gross_profit,
       round(coalesce(s.net_no_cost, 0), 2)        as net_no_cost,
       coalesce(s.has_override, false)             as cost_entered,
       coalesce(l.labels, 0)                       as labels,
       coalesce(l.label_cost, 0)                   as label_cost,
       l.services,
       round(coalesce(s.net - s.cogs, 0) + o.shipping - coalesce(l.label_cost, 0), 2) as profit_after_shipping
from jt.shopify_orders o
left join s using (order_id)
left join l using (order_id);

-- Product sales tab: sum over any date range.
create or replace view jt.v_product_sales_daily as
select day, product_type, vendor, product_title, product_id, sales_channel,
       sum(units) as units, sum(gross) as gross, sum(discounts) as discounts, sum(returns) as returns,
       sum(net) as net, sum(cogs + cost_added) as cogs, sum(net - cogs - cost_added) as gross_profit,
       sum(net_no_cost_adj) as net_no_cost
from jt.v_sales_adjusted
group by 1, 2, 3, 4, 5, 6;

-- Cost mapping tab: orders that still have sales without a cost.
create or replace view jt.v_costmap_orders as
select o.order_id, o.order_name, o.first_day, o.net, o.cogs, o.net_no_cost,
       so.created_at, so.order_day
from jt.v_order_sales o
left join jt.cost_overrides ov using (order_id)
left join jt.shopify_orders so using (order_id)
where ov.order_id is null and o.net_no_cost >= 0.01;

-- Lines to fill for those orders: items still in the order that match a no-cost sales row
-- (custom items match any no-cost custom row), with today's Shopify cost as a suggestion.
create or replace view jt.v_costmap_lines as
with nc as (
  select order_id, variant_id from jt.shopify_sales group by 1, 2 having sum(net_no_cost) >= 0.01
)
select l.order_id, l.line_id, l.variant_id, l.product_id, l.title, l.variant_title, l.sku,
       l.current_quantity as qty, l.unit_price, v.unit_cost as shopify_cost_now
from jt.shopify_order_lines l
join nc on nc.order_id = l.order_id and nc.variant_id = coalesce(l.variant_id, 0)
left join jt.variants v on v.variant_id = l.variant_id
where l.current_quantity > 0;

-- ---------------------------------------------------------------- Amazon
create or replace view jt.v_amazon_lines as
select t.*,
       m.kind as map_kind,
       case when t.type = 'Order' then
         t.quantity * case m.kind when 'manual' then m.manual_cost
                                  when 'shopify' then m.units * jt.variant_cost_on(m.variant_id, t.day) end
       end as product_cost
from jt.amazon_transactions t
left join jt.amazon_map m on m.sku = t.sku;

create or replace view jt.v_amazon_daily as
select day,
       count(distinct order_id) filter (where type = 'Order')           as orders,
       coalesce(sum(quantity) filter (where type = 'Order'), 0)          as units,
       coalesce(sum(product_sales) filter (where type = 'Order'), 0)     as sales,
       coalesce(sum(total) filter (where type = 'Order'), 0)             as orders_net,
       coalesce(sum(total) filter (where type = 'Refund'), 0)            as refunds_net,
       coalesce(sum(total) filter (where type not in ('Order', 'Refund', 'Transfer')), 0) as other_net,
       coalesce(sum(product_cost), 0)                                    as product_cost,
       coalesce(sum(product_sales) filter (where type = 'Order' and product_cost is null), 0) as sales_without_cost
from jt.v_amazon_lines
group by day;

-- ---------------------------------------------------------------- health
create or replace view jt.v_sync_status as
select distinct on (job) job, started_at, finished_at, ok, rows, detail
from jt.sync_runs order by job, started_at desc;

-- ---------------------------------------------------------------- writes from the dashboard
create or replace function jt.save_cost_override(p jsonb) returns void language sql as $$
  insert into jt.cost_overrides (order_id, order_name, cost, shopify_cogs, lines, src, note, updated_at)
  values ((p->>'order_id')::bigint, coalesce(p->>'order_name', ''), (p->>'cost')::numeric,
          (p->>'shopify_cogs')::numeric, coalesce(p->'lines', '{}'::jsonb), coalesce(p->>'src', 'dashboard'),
          coalesce(p->>'note', ''), now())
  on conflict (order_id) do update set
    order_name = excluded.order_name, cost = excluded.cost, shopify_cogs = excluded.shopify_cogs,
    lines = excluded.lines, src = excluded.src, note = excluded.note, updated_at = now();
$$;

create or replace function jt.delete_cost_override(p_order_id bigint) returns void language sql as $$
  delete from jt.cost_overrides where order_id = p_order_id;
$$;

create or replace function jt.save_amazon_map(p jsonb) returns void language sql as $$
  insert into jt.amazon_map (sku, asin, kind, variant_id, product_id, vsku, vtitle, vendor, units, manual_cost, unit_cost_at_map, updated_at)
  values (p->>'sku', coalesce(p->>'asin', ''), p->>'kind', (p->>'variant_id')::bigint, (p->>'product_id')::bigint,
          coalesce(p->>'vsku', ''), coalesce(p->>'vtitle', ''), coalesce(p->>'vendor', ''),
          coalesce((p->>'units')::numeric, 1), (p->>'manual_cost')::numeric, (p->>'unit_cost_at_map')::numeric, now())
  on conflict (sku) do update set
    asin = excluded.asin, kind = excluded.kind, variant_id = excluded.variant_id, product_id = excluded.product_id,
    vsku = excluded.vsku, vtitle = excluded.vtitle, vendor = excluded.vendor, units = excluded.units,
    manual_cost = excluded.manual_cost, unit_cost_at_map = excluded.unit_cost_at_map, updated_at = now();
$$;

create or replace function jt.delete_amazon_map(p_sku text) returns void language sql as $$
  delete from jt.amazon_map where sku = p_sku;
$$;

create or replace function jt.set_cost_change_kind(p_id bigint, p_kind text) returns void language sql as $$
  update jt.variant_cost_changes set kind = p_kind where id = p_id;
$$;

create or replace function jt.set_setting(p_key text, p_value jsonb) returns void language sql as $$
  insert into jt.settings (key, value, updated_at) values (p_key, p_value, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
$$;
