-- Amazon money from the Finances API (2024-06-19 listTransactions), instead of uploading the Transaction report.
-- (Amazon doesn't let this account request the Transaction report itself through the API.)
--
-- jt.amazon_fin_lines: one row per transaction item, amounts flattened to {"Path/To/Leaf": amount}, e.g.
--   ProductCharges/OurPricePrincipal, AmazonFees/Commission/Base, AmazonFees/FBAPerUnitFulfillmentFee/Base.
-- jt_amazon_fin_build turns a range of Pacific days into the Amazon tab's day documents (jt.docs amzdays/<date>),
-- the same shape the Transaction report upload writes, then rebuilds the month summaries (amzmonths).
-- The lines stay so any day can be re-built (about 1,500 a day).

create table if not exists jt.amazon_fin_lines (
  transaction_id text not null,
  item           integer not null default 0,
  posted_at      timestamptz not null,
  type           text not null default '',     -- Shipment, Refund, ServiceFee, Adjustment, FBAInventoryReimbursement, …
  description    text not null default '',
  status         text not null default '',     -- RELEASED, DEFERRED, DEFERRED_RELEASED
  order_id       text not null default '',
  marketplace    text not null default '',     -- marketplace id
  currency       text not null default '',
  sku            text not null default '',
  qty            integer not null default 0,
  fulfillment    text not null default '',     -- AFN (FBA) | MFN
  total          numeric(12,2) not null default 0,
  amounts        jsonb not null default '{}'::jsonb,
  updated_at     timestamptz not null default now(),
  primary key (transaction_id, item)
);
create index if not exists amazon_fin_lines_day on jt.amazon_fin_lines (((posted_at at time zone 'America/Los_Angeles')::date));

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.amazon_fin_lines to jt_reader;
  end if;
end $$;

-- sum of the amounts whose path matches a pattern
create or replace function jt.fin_sum(a jsonb, pat text) returns numeric
language sql immutable set search_path = '' as $$
  select coalesce(sum(value::numeric), 0) from jsonb_each_text(a) where key ~ pat;
$$;

-- p = {day, lines: [...]}: replaces the saved lines of those transactions
create or replace function public.jt_amazon_fin_lines_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into jt.amazon_fin_lines as t (transaction_id, item, posted_at, type, description, status, order_id, marketplace,
                                        currency, sku, qty, fulfillment, total, amounts, updated_at)
  select x.transaction_id, coalesce(x.item, 0), x.posted_at, coalesce(x.type, ''), coalesce(x.description, ''),
         coalesce(x.status, ''), coalesce(x.order_id, ''), coalesce(x.marketplace, ''), coalesce(x.currency, ''),
         coalesce(x.sku, ''), coalesce(x.qty, 0), coalesce(x.fulfillment, ''), coalesce(x.total, 0),
         coalesce(x.amounts, '{}'::jsonb), now()
  from jsonb_to_recordset(p->'lines') as x(transaction_id text, item int, posted_at timestamptz, type text, description text,
       status text, order_id text, marketplace text, currency text, sku text, qty int, fulfillment text, total numeric, amounts jsonb)
  where x.transaction_id is not null and x.posted_at is not null
  on conflict (transaction_id, item) do update set
    posted_at = excluded.posted_at, type = excluded.type, description = excluded.description, status = excluded.status,
    order_id = excluded.order_id, marketplace = excluded.marketplace, currency = excluded.currency, sku = excluded.sku,
    qty = excluded.qty, fulfillment = excluded.fulfillment, total = excluded.total, amounts = excluded.amounts, updated_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- How each transaction line counts on the Amazon tab (US marketplace only, like the Transaction report):
--   kind: order | refund | other;  for other, cat: storage | fbaother | service | labels | adjust
create or replace view jt.v_amazon_fin_lines as
select l.*,
       (l.posted_at at time zone 'America/Los_Angeles')::date as day,
       to_char(l.posted_at at time zone 'America/Los_Angeles', 'HH24:MI') as hm,
       case when l.type = 'Shipment' then 'order' when l.type = 'Refund' then 'refund' else 'other' end as kind,
       case
         when l.type in ('Shipment', 'Refund') then null
         when l.description ~* 'storage' or l.type ~* 'storage' then 'storage'
         when l.type = 'ServiceFee' then 'service'
         when l.type ~* 'shipping|label' or l.description ~* 'label' then 'labels'
         when l.type ~* '^FBA' and l.type !~* 'reimburse' then 'fbaother'
         else 'adjust'
       end as cat,
       jt.fin_sum(l.amounts, '^ProductCharges')                           as sales,
       jt.fin_sum(l.amounts, '^(Shipping|GiftWrap)')                      as ship,
       jt.fin_sum(l.amounts, '^Promotion')                                as promo,
       jt.fin_sum(l.amounts, '^AmazonFees/(?!FBA)')                       as sellfees,
       jt.fin_sum(l.amounts, '^AmazonFees/FBA')                           as fbafees
from jt.amazon_fin_lines l
where l.marketplace = 'ATVPDKIKX0DER';

-- p = {first, last, target: 'amzdays' | 'amzdays_api', file}
create or replace function public.jt_amazon_fin_build(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  tgt text := coalesce(p->>'target', 'amzdays');
  days jsonb;
begin
  if tgt not in ('amzdays', 'amzdays_api') then raise exception 'unknown target %', tgt; end if;
  with l as (
    select * from jt.v_amazon_fin_lines where day between (p->>'first')::date and (p->>'last')::date
  ),
  sk as (   -- each day's SKU list, in order of first appearance
    select day, sku, (row_number() over (partition by day order by min(posted_at), sku) - 1)::int as ix
    from l where kind in ('order', 'refund') and sku <> '' group by day, sku
  ),
  d as (
    select l.day,
      coalesce((select jsonb_agg(s.sku order by s.ix) from sk s where s.day = l.day), '[]'::jsonb) as skus,
      coalesce(jsonb_agg(jsonb_build_array(l.hm, l.order_id, s.ix, l.qty, round(l.sales, 2), round(l.ship, 2), round(l.promo, 2),
                                           round(l.sellfees, 2), round(l.fbafees, 2), round(l.total, 2), case when l.fulfillment = 'AFN' then 1 else 0 end)
                         order by l.posted_at, l.transaction_id, l.item) filter (where l.kind = 'order'), '[]'::jsonb) as orders,
      coalesce(jsonb_agg(jsonb_build_array(l.hm, l.order_id, coalesce(s.ix, -1), abs(l.qty), round(l.sales + l.ship + l.promo, 2),
                                           round(l.sellfees + l.fbafees, 2), round(l.total, 2))
                         order by l.posted_at, l.transaction_id, l.item) filter (where l.kind = 'refund'), '[]'::jsonb) as refunds,
      coalesce((select jsonb_object_agg(o.cat, o.v) from (select cat, round(sum(total), 2) v from l l2 where l2.day = l.day and l2.kind = 'other' group by cat) o), '{}'::jsonb) as other,
      jsonb_strip_nulls(jsonb_build_object(
        'orders', count(distinct l.order_id) filter (where l.kind = 'order'),
        'units', coalesce(sum(l.qty) filter (where l.kind = 'order'), 0),
        'sales', round(coalesce(sum(l.sales) filter (where l.kind = 'order'), 0), 2),
        'ship', round(coalesce(sum(l.ship) filter (where l.kind = 'order'), 0), 2),
        'promo', round(coalesce(sum(l.promo) filter (where l.kind = 'order'), 0), 2),
        'sellfees', round(coalesce(sum(l.sellfees) filter (where l.kind = 'order'), 0), 2),
        'fbafees', round(coalesce(sum(l.fbafees) filter (where l.kind = 'order'), 0), 2),
        'orders_net', round(coalesce(sum(l.total) filter (where l.kind = 'order'), 0), 2),
        'refunds_net', round(sum(l.total) filter (where l.kind = 'refund'), 2),
        'refund_sales', round(sum(l.sales + l.ship + l.promo) filter (where l.kind = 'refund'), 2),
        'refund_units', sum(abs(l.qty)) filter (where l.kind = 'refund'),
        'other', round(sum(l.total) filter (where l.kind = 'other'), 2))) as totals
    from l left join sk s on s.day = l.day and s.sku = l.sku
    group by l.day
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'skus', skus, 'orders', orders, 'refunds', refunds,
           'other', other, 'totals', totals, 'file', coalesce(p->>'file', 'SP-API Finances'),
           'uploadedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), '[]'::jsonb)
  into days from d;
  if jsonb_array_length(days) = 0 then return 0; end if;
  return public.jt_amazon_fin_save(jsonb_build_object('target', tgt, 'days', days));
end $$;

revoke all on function public.jt_amazon_fin_lines_save(jsonb), public.jt_amazon_fin_build(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_amazon_fin_lines_save(jsonb), public.jt_amazon_fin_build(jsonb) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_amazon_fin_lines_save(jsonb), public.jt_amazon_fin_build(jsonb) to service_role;
  end if;
end $$;
