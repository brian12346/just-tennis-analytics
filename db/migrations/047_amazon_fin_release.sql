-- Finances API: Amazon posts a deferred order once when it happens (DEFERRED, later DEFERRED_RELEASED) and again when
-- the money is released (RELEASED, with a DEFERRED_TRANSACTION_ID pointing back). The Transaction report counts it
-- once, on the first date, so the release copy is left out (kind 'release').
-- Also: shipping discounts come as PromoRebates/…, and a shipping chargeback isn't a selling fee (the Transaction
-- report puts it under "other transaction fees", which only shows in the order's total).
alter table jt.amazon_fin_lines add column if not exists release_of text not null default '';

create or replace function public.jt_amazon_fin_lines_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into jt.amazon_fin_lines as t (transaction_id, item, posted_at, type, description, status, order_id, marketplace,
                                        currency, sku, qty, fulfillment, total, amounts, release_of, updated_at)
  select x.transaction_id, coalesce(x.item, 0), x.posted_at, coalesce(x.type, ''), coalesce(x.description, ''),
         coalesce(x.status, ''), coalesce(x.order_id, ''), coalesce(x.marketplace, ''), coalesce(x.currency, ''),
         coalesce(x.sku, ''), coalesce(x.qty, 0), coalesce(x.fulfillment, ''), coalesce(x.total, 0),
         coalesce(x.amounts, '{}'::jsonb), coalesce(x.release_of, ''), now()
  from jsonb_to_recordset(p->'lines') as x(transaction_id text, item int, posted_at timestamptz, type text, description text,
       status text, order_id text, marketplace text, currency text, sku text, qty int, fulfillment text, total numeric,
       amounts jsonb, release_of text)
  where x.transaction_id is not null and x.posted_at is not null
  on conflict (transaction_id, item) do update set
    posted_at = excluded.posted_at, type = excluded.type, description = excluded.description, status = excluded.status,
    order_id = excluded.order_id, marketplace = excluded.marketplace, currency = excluded.currency, sku = excluded.sku,
    qty = excluded.qty, fulfillment = excluded.fulfillment, total = excluded.total, amounts = excluded.amounts,
    release_of = excluded.release_of, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace view jt.v_amazon_fin_lines as
select l.transaction_id, l.item, l.posted_at, l.type, l.description, l.status, l.order_id, l.marketplace, l.currency,
       l.sku, l.qty, l.fulfillment, l.total, l.amounts, l.updated_at,
       (l.posted_at at time zone 'America/Los_Angeles')::date as day,
       to_char(l.posted_at at time zone 'America/Los_Angeles', 'HH24:MI') as hm,
       case when l.release_of <> '' then 'release'
            when l.type = 'Shipment' then 'order' when l.type = 'Refund' then 'refund' else 'other' end as kind,
       case
         when l.type in ('Shipment', 'Refund') or l.release_of <> '' then null
         when l.description ~* 'storage' or l.type ~* 'storage' then 'storage'
         when l.type = 'ServiceFee' then 'service'
         when l.type ~* 'shipping|label' or l.description ~* 'label' then 'labels'
         when l.type ~* '^FBA' and l.type !~* 'reimburse' then 'fbaother'
         else 'adjust'
       end as cat,
       jt.fin_sum(l.amounts, '^ProductCharges')                                      as sales,
       jt.fin_sum(l.amounts, '^(Shipping|GiftWrap)')                                 as ship,
       jt.fin_sum(l.amounts, '^(Promotion|PromoRebates)')                            as promo,
       jt.fin_sum(l.amounts, '^AmazonFees/(?!FBA|ShippingChargeback)')               as sellfees,
       jt.fin_sum(l.amounts, '^AmazonFees/FBA')                                      as fbafees,
       l.release_of
from jt.amazon_fin_lines l
where l.marketplace = 'ATVPDKIKX0DER';
