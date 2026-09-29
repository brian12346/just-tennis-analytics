-- Amazon fees per seller SKU, from the Transaction reports loaded into jt.docs (amzdays/<date>).
--
-- Used by the FBA inventory tab to estimate what Amazon will take when each unit in FBA sells:
--   referral rate  = -sell_fees / sales            (all orders of the SKU)
--   FBA fee / unit = -fba_fees / fba_units          (FBA-fulfilled orders only)
-- Window: the 180 days up to the latest day loaded, so recent fee changes count and old ones age out.
--
-- amzdays orders are arrays [time, orderId, skuIdx, qty, sales, ship, promo, sellfees, fbafees, total, fba].
-- The CTE is materialized so each day's JSON is read once (without it the query took ~25 s instead of ~0.2 s).

create or replace view jt.v_amz_sku_fees as
with last as (
  select max(id) as d from jt.docs where collection = 'amzdays'
),
days as materialized (
  select d.id, d.data->'orders' as o, d.data->'skus' as s
  from jt.docs d, last
  where d.collection = 'amzdays' and last.d is not null and d.id > to_char(last.d::date - 180, 'YYYY-MM-DD')
),
e as (
  select x.id, x.s ->> ((x.e ->> 2)::int) as sku,
         (x.e ->> 3)::numeric as qty, (x.e ->> 4)::numeric as sales,
         (x.e ->> 7)::numeric as sell_fees, (x.e ->> 8)::numeric as fba_fees, (x.e ->> 10) = '1' as fba
  from (select id, s, jsonb_array_elements(o) as e from days) x
)
select sku,
       sum(qty)                                   as units,
       round(sum(sales), 2)                       as sales,
       round(sum(sell_fees), 2)                   as sell_fees,
       coalesce(sum(qty) filter (where fba), 0)   as fba_units,
       round(coalesce(sum(fba_fees) filter (where fba), 0), 2) as fba_fees,
       max(id)                                    as last_sold
from e
where sku is not null
group by sku;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.v_amz_sku_fees to jt_reader;
  end if;
end $$;
