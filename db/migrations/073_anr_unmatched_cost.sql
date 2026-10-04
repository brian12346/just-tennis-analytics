-- Ace n Rally: a product with no Just Tennis match keeps the cost Ace n Rally's Shopify recorded on the sale (it does
-- record costs for some products, e.g. Selkirk LABS BoomStik). Migration 071 counted those sales as "no cost", which
-- took their net sales back out of gross profit (March 2026 showed −$13K).
create or replace view jt.v_anr_sales_costed as
select s.day, s.order_id, s.order_name, s.variant_id, s.product_id, s.product_title, s.variant_title, s.sku, s.product_type,
       s.vendor, s.sales_channel, s.units, s.gross, s.discounts, s.returns, s.net,
       case when v.unit_cost is not null then round(s.units * m.units * v.unit_cost, 2) else s.cogs end as cogs,
       case when v.unit_cost is not null then 0 else s.net_no_cost end as net_no_cost,
       s.cogs as cogs_recorded, s.net_no_cost as net_no_cost_recorded, m.jt_variant_id, m.how as match_how
from jt.anr_sales s
left join jt.v_anr_variant_map m on m.anr_variant_id = s.variant_id and s.variant_id <> 0
left join jt.variants v on v.variant_id = m.jt_variant_id and v.unit_cost > 0;
