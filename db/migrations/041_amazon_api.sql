-- Amazon Selling Partner API (SP-API). The LWA credentials live in Supabase Vault (spapi_client_id,
-- spapi_client_secret, spapi_refresh_token). The `amazon` edge function reads them through jt_spapi_creds()
-- (service role only), and pulls orders from Amazon's order reports into jt.amazon_order_lines:
--   one row per order + seller SKU, for the US, Canada and Mexico marketplaces (and Non-Amazon = multi-channel
--   orders Amazon fulfilled for another store, which are not Amazon sales).
-- Reports are asynchronous: the function asks Amazon for a report (jt.amazon_reports, status requested), and a later
-- call picks it up once Amazon has made it. pg_cron calls the function every 10 minutes (see the end of this file).

create table if not exists jt.amazon_reports (
  report_id     text primary key,
  report_type   text not null,
  kind          text not null default 'recent',     -- recent | backfill
  marketplaces  text[] not null default '{}',
  data_start    timestamptz,
  data_end      timestamptz,
  requested_at  timestamptz not null default now(),
  requested_by  text not null default '',
  status        text not null default 'requested',  -- requested | done | failed
  processed_at  timestamptz,
  rows          integer,
  detail        text not null default ''
);

create table if not exists jt.amazon_order_lines (
  order_id        text not null,
  sku             text not null,
  asin            text not null default '',
  merchant_order_id text not null default '',
  purchase_at     timestamptz not null,
  last_updated_at timestamptz,
  order_status    text not null default '',      -- Pending, Shipped, Cancelled, …
  item_status     text not null default '',
  fulfillment     text not null default '',      -- Amazon (FBA) | Merchant
  sales_channel   text not null default '',      -- Amazon.com | Amazon.ca | Amazon.com.mx | Non-Amazon
  marketplace     text not null default '',      -- us | ca | mx | other
  product_name    text not null default '',
  quantity        integer not null default 0,
  currency        text not null default '',
  item_price      numeric(12,2) not null default 0,   -- for the whole line (all units), before tax
  item_tax        numeric(12,2) not null default 0,
  shipping_price  numeric(12,2) not null default 0,
  shipping_tax    numeric(12,2) not null default 0,
  gift_wrap_price numeric(12,2) not null default 0,
  item_promo      numeric(12,2) not null default 0,   -- discounts, as Amazon reports them (negative)
  ship_promo      numeric(12,2) not null default 0,
  is_business     boolean not null default false,
  ship_state      text not null default '',
  ship_country    text not null default '',
  report_id       text not null default '',
  updated_at      timestamptz not null default now(),
  primary key (order_id, sku)
);
create index if not exists amazon_order_lines_purchase on jt.amazon_order_lines (purchase_at);
create index if not exists amazon_order_lines_sku on jt.amazon_order_lines (sku);

-- Exchange rates to US dollars for Canada and Mexico sales (editable; a rough rate is fine for daily sales).
insert into jt.settings (key, value) values ('amazon_fx', '{"USD": 1, "CAD": 0.72, "MXN": 0.054}'::jsonb)
on conflict (key) do nothing;

-- Sales lines in dollars, by Pacific-time purchase day (how Seller Central counts days). Cancelled lines and
-- Non-Amazon (multi-channel) orders are left out.
create or replace view jt.v_amazon_api_lines as
select l.*,
       (l.purchase_at at time zone 'America/Los_Angeles')::date as day,
       coalesce((select (s.value ->> l.currency)::numeric from jt.settings s where s.key = 'amazon_fx'), case when l.currency in ('', 'USD') then 1 end) as fx,
       round(l.item_price * coalesce((select (s.value ->> l.currency)::numeric from jt.settings s where s.key = 'amazon_fx'), case when l.currency in ('', 'USD') then 1 end), 2) as sales_usd,
       round((l.item_price + l.item_promo) * coalesce((select (s.value ->> l.currency)::numeric from jt.settings s where s.key = 'amazon_fx'), case when l.currency in ('', 'USD') then 1 end), 2) as net_sales_usd
from jt.amazon_order_lines l
where l.marketplace in ('us', 'ca', 'mx')
  and l.order_status <> 'Cancelled' and l.item_status <> 'Cancelled';

create or replace view jt.v_amazon_api_daily as
select day, marketplace,
       count(distinct order_id)                           as orders,
       sum(quantity)                                      as units,
       sum(sales_usd)                                     as sales,
       sum(net_sales_usd)                                 as net_sales,
       count(distinct order_id) filter (where order_status = 'Pending') as pending_orders,
       sum(sales_usd) filter (where fulfillment = 'Amazon') as fba_sales
from jt.v_amazon_api_lines
group by day, marketplace;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.amazon_reports, jt.amazon_order_lines, jt.v_amazon_api_lines, jt.v_amazon_api_daily to jt_reader;
  end if;
end $$;

-- Credentials for the edge function (service role only).
create or replace function public.jt_spapi_creds() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if to_regnamespace('vault') is null then return '{}'::jsonb; end if;
  return (select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb) from vault.decrypted_secrets
    where name in ('spapi_client_id', 'spapi_client_secret', 'spapi_refresh_token', 'jt_fn_key'));
end $$;
revoke all on function public.jt_spapi_creds() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_spapi_creds() from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_spapi_creds() to service_role;
  end if;
end $$;

-- Calling the edge function from SQL (asynchronous, like jt.qbo_call): returns a pg_net request id;
-- jt.qbo_result(id) reads the answer.
create or replace function jt.amazon_call(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/amazon', body := p, timeout_milliseconds := 120000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $$;
revoke all on function jt.amazon_call(jsonb) from public;
