-- Inventory value › over time (Nov 19, Brian: "add a graph to show inventory over time to the inventory value chart —
-- break down by vendor and category"). Units and value at each month end, by vendor and product type, in each place:
--   store — Shopify's inventory history (jt.inventory_monthly)
--   prep  — the prep center's log: each (variant, Amazon SKU)'s last qty_after before the month ended (jt.prep_moves)
--   fba   — Amazon's FBA Inventory Ledger, sellable ending balance, in Shopify units (jt.fba_ledger_monthly)
--   awd   — the hourly snapshots (jt.stock_daily, from Nov 5, 2026): the month's last day
-- The current month is the latest snapshot (jt.stock_daily: every location at once). Valued at today's Shopify unit cost.
-- has_* says whether that location has data for the month at all (false = unknown, not zero).
create or replace function jt.stock_value_history(n integer default 13)
returns table (month date, vendor text, category text,
               store_u integer, store_v numeric, prep_u integer, prep_v numeric, fba_u integer, fba_v numeric, awd_u integer, awd_v numeric,
               has_store boolean, has_prep boolean, has_fba boolean, has_awd boolean)
language sql stable security definer set search_path = '' as $$
  with t as (select (now() at time zone 'America/Los_Angeles')::date as today),
  m as (select (date_trunc('month', t.today) - make_interval(months => g))::date as month, g = 0 as cur from t, generate_series(0, greatest(n, 1) - 1) g),
  me as (select m.month, m.cur, ((m.month + interval '1 month')::timestamp at time zone 'America/Los_Angeles') as cut,
                (select max(d.day) from jt.stock_daily d where d.day >= m.month and d.day < (m.month + interval '1 month')::date) as snap
         from m),
  skus as (select c.sku, c.variant_id, coalesce(c.map_units, 1) as per from jt.mv_amz_sku_cost c where c.variant_id is not null),
  u as (
    -- current month: the latest snapshot, every location
    select me.month, d.variant_id, d.store as su, d.prep as pu, d.fba as fu, d.awd as au from me join jt.stock_daily d on d.day = me.snap where me.cur
    union all
    select me.month, i.variant_id, greatest(i.end_units, 0), 0, 0, 0 from me join jt.inventory_monthly i on i.month = me.month where not me.cur and i.end_units > 0
    union all
    select me.month, x.variant_id, 0, x.q, 0, 0 from me cross join lateral (
        select p.variant_id, sum(p.qty_after)::int as q from (select distinct on (pm.variant_id, pm.amazon_sku) pm.variant_id, pm.qty_after
          from jt.prep_moves pm where pm.at < me.cut order by pm.variant_id, pm.amazon_sku, pm.at desc, pm.id desc) p group by 1 having sum(p.qty_after) > 0) x
      where not me.cur
    union all
    select me.month, s.variant_id, 0, 0, sum(l.end_units * s.per)::int, 0 from me join jt.fba_ledger_monthly l on l.month = me.month and l.disposition = 'SELLABLE'
      join skus s on s.sku = l.sku where not me.cur group by 1, 2
    union all
    select me.month, d.variant_id, 0, 0, 0, d.awd from me join jt.stock_daily d on d.day = me.snap where not me.cur and d.awd > 0
  )
  select me.month, coalesce(nullif(trim(v.vendor), ''), 'Unknown vendor'), coalesce(nullif(trim(v.product_type), ''), 'No category'),
    sum(u.su)::int, round(sum(u.su * coalesce(v.unit_cost, 0)), 2), sum(u.pu)::int, round(sum(u.pu * coalesce(v.unit_cost, 0)), 2),
    sum(u.fu)::int, round(sum(u.fu * coalesce(v.unit_cost, 0)), 2), sum(u.au)::int, round(sum(u.au * coalesce(v.unit_cost, 0)), 2),
    bool_or(me.cur and me.snap is not null) or bool_or(exists (select 1 from jt.inventory_monthly i where i.month = me.month)),
    bool_or(me.cur and me.snap is not null) or bool_or(exists (select 1 from jt.prep_moves p where p.at < me.cut)),
    bool_or(me.cur and me.snap is not null) or bool_or(exists (select 1 from jt.fba_ledger_monthly l where l.month = me.month)),
    bool_or(me.snap is not null)
  from me join u on u.month = me.month left join jt.variants v on v.variant_id = u.variant_id
  group by 1, 2, 3
  order by 1, 2, 3
$$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant execute on function jt.stock_value_history(integer) to jt_reader;
  end if;
end $$;
