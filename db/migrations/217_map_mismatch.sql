-- MAP scan (216) follow-up, Nov 10: the first Wilson scan showed 7 listings where every seller looked 90%+ under MAP.
-- every offer under MAP on the newest scan of each brand (Just Tennis's own offers included, flagged). "mismatch": the
-- listing's median offer is under half the MAP — the UPC on the MAP file is a different pack than the ASIN (a reel's UPC on
-- a set's listing); its offers are kept but aren't MAP violations (the first scan had 7, all strings and grips at 6–11% of MAP).
drop view if exists jt.v_map_violations;
create view jt.v_map_violations as
with s as (select distinct on (lower(brand)) id, brand, started_at from jt.map_scans order by lower(brand), id desc),
med as (select o.scan_id, o.asin, (percentile_cont(0.5) within group (order by o.listing_price))::numeric as median
        from jt.map_scan_offers o join s on s.id = o.scan_id group by 1, 2)
select s.brand, s.id as scan_id, s.started_at as scanned_at, a.asin, a.title, a.item_sku, a.upc, a.map_price,
       o.seller_id, o.seller_id = 'AJPAM6HXYXK3Y' as ours, o.seller_id = 'ATVPDKIKX0DER' as amazon_retail,
       o.fba, o.listing_price, o.shipping, o.listing_price + coalesce(o.shipping, 0) as landed, o.buybox, o.prime, o.feedback_count, o.feedback_pct,
       round(a.map_price - o.listing_price, 2) as under_by, round((a.map_price - o.listing_price) / a.map_price * 100, 1) as under_pct,
       coalesce(med.median < a.map_price * 0.5, false) as mismatch,
       'https://www.amazon.com/dp/' || a.asin as listing_url, 'https://www.amazon.com/sp?seller=' || o.seller_id as seller_url
from s join jt.map_scan_asins a on a.scan_id = s.id join jt.map_scan_offers o on o.scan_id = s.id and o.asin = a.asin
left join med on med.scan_id = s.id and med.asin = a.asin
where o.listing_price < a.map_price - 0.005;

grant select on jt.v_map_violations to jt_reader;
