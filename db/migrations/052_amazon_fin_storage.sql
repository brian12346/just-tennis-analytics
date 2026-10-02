-- Other Amazon charges, by what they are: storage billing (monthly, long-term, AWD/STAR) is "Storage"; inbound
-- transportation/placement, inbound convenience, removal, disposal and AWD handling are "FBA other". (The Transaction
-- report files storage billing and inbound transportation the other way round; the total is the same.)
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
         when l.description ~* 'storage' or l.type ~* 'storage' then 'storage'
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
