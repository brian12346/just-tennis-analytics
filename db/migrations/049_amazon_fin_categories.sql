-- Finances API, matched to how the Transaction report groups the other charges (checked Sep 9–20, 2026):
--   inbound placement/transport (FBAPostInboundTransportation) and storage -> "FBA Inventory Fee" (storage)
--   other FBA / AWD service fees (inbound convenience, removal, AWD processing/transport) -> "FBA Transaction fees"
--   remaining service fees (subscription, …) -> "Service Fee"
-- Also: some orders (invoiced/business orders) list the fulfilment fee as FBAFees/…; it counts as an FBA fee.
create or replace view jt.v_amazon_fin_lines as
select l.transaction_id, l.item, l.posted_at, l.type, l.description, l.status, l.order_id, l.marketplace, l.currency,
       l.sku, l.qty, l.fulfillment, l.total, l.amounts, l.updated_at,
       (l.posted_at at time zone 'America/Los_Angeles')::date as day,
       to_char(l.posted_at at time zone 'America/Los_Angeles', 'HH24:MI') as hm,
       case when l.release_of <> '' then 'release'
            when l.type = 'Transfer' then 'transfer'
            when l.type = 'Shipment' then 'order' when l.type = 'Refund' then 'refund' else 'other' end as kind,
       case
         when l.type in ('Shipment', 'Refund', 'Transfer') or l.release_of <> '' then null
         when l.description ~* 'storage|PostInboundTransportation|InboundPlacement' or l.type ~* 'storage' then 'storage'
         when l.type ~* 'shipping|label' or l.description ~* 'label' then 'labels'
         when l.type = 'ServiceFee' and l.description ~* '^(FBA|AWD)' then 'fbaother'
         when l.type = 'ServiceFee' then 'service'
         when l.type ~* '^FBA' and l.type !~* 'reimburse' then 'fbaother'
         else 'adjust'
       end as cat,
       jt.fin_sum(l.amounts, '^ProductCharges')                                      as sales,
       jt.fin_sum(l.amounts, '^(Shipping|GiftWrap)')                                 as ship,
       jt.fin_sum(l.amounts, '^(Promotion|PromoRebates)')                            as promo,
       jt.fin_sum(l.amounts, '^AmazonFees/(?!FBA|ShippingChargeback)')               as sellfees,
       jt.fin_sum(l.amounts, '^(AmazonFees/(FBA|ShippingChargeback)|FBAFees/)')      as fbafees,
       l.release_of
from jt.amazon_fin_lines l
where l.marketplace = 'ATVPDKIKX0DER';
