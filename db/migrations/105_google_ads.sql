-- Google Ads spend (Brian, Oct 7): a Google Ads script in each store's Google Ads account posts daily spend by campaign
-- (jt_google_ads_ingest, with a key kept in Vault as google_ads_ingest_key). Spend shows as Ad spend in All sales and
-- comes off that store's profit. Amazon ads come later through the Amazon Ads API.

create table if not exists jt.google_ads_daily (
  store         text not null check (store in ('justtennis', 'acenrally')),
  day           date not null,
  campaign_id   text not null,
  campaign      text not null default '',
  channel_type  text not null default '',          -- SEARCH, SHOPPING, PERFORMANCE_MAX, …
  cost          numeric not null default 0,         -- account currency (USD)
  clicks        integer not null default 0,
  impressions   integer not null default 0,
  conversions   numeric not null default 0,
  conv_value    numeric not null default 0,
  account_id    text not null default '',
  synced_at     timestamptz not null default now(),
  primary key (store, day, campaign_id)
);

-- p = {store, account: {id, name, tz, currency}, from, to, rows: [{day, campaign_id, campaign, type, cost, clicks,
-- impressions, conversions, conv_value}]}. Rows in [from, to] that aren't sent any more go to zero (no deletes).
create or replace function jt.google_ads_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st text := p->>'store'; d0 date := (p->>'from')::date; d1 date := (p->>'to')::date; n int; acct text := coalesce(p->'account'->>'id', '');
begin
  if st not in ('justtennis', 'acenrally') then raise exception 'unknown store %', st; end if;
  if d0 is null or d1 is null or d1 < d0 or d1 - d0 > 800 then raise exception 'from / to dates missing or out of range'; end if;
  update jt.google_ads_daily set cost = 0, clicks = 0, impressions = 0, conversions = 0, conv_value = 0, synced_at = now()
  where store = st and day between d0 and d1 and (cost <> 0 or clicks <> 0 or impressions <> 0 or conversions <> 0);
  insert into jt.google_ads_daily as t (store, day, campaign_id, campaign, channel_type, cost, clicks, impressions, conversions, conv_value, account_id, synced_at)
  select st, (r->>'day')::date, r->>'campaign_id', max(coalesce(r->>'campaign', '')), max(coalesce(r->>'type', '')),
         sum(coalesce((r->>'cost')::numeric, 0)), sum(coalesce((r->>'clicks')::int, 0)), sum(coalesce((r->>'impressions')::int, 0)),
         sum(coalesce((r->>'conversions')::numeric, 0)), sum(coalesce((r->>'conv_value')::numeric, 0)), acct, now()
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) r
  where coalesce(r->>'campaign_id', '') <> '' and (r->>'day')::date between d0 and d1
  group by 2, 3
  on conflict (store, day, campaign_id) do update set campaign = excluded.campaign, channel_type = excluded.channel_type, cost = excluded.cost,
    clicks = excluded.clicks, impressions = excluded.impressions, conversions = excluded.conversions, conv_value = excluded.conv_value,
    account_id = excluded.account_id, synced_at = now();
  get diagnostics n = row_count;
  insert into jt.settings (key, value) values ('google_ads', '{}'::jsonb) on conflict (key) do nothing;
  update jt.settings set value = value || jsonb_build_object(st, jsonb_build_object('at', now(), 'account', coalesce(p->'account', '{}'::jsonb),
    'from', d0, 'to', d1, 'rows', n, 'cost', (select coalesce(sum(cost), 0) from jt.google_ads_daily where store = st and day between d0 and d1)))
  where key = 'google_ads';
  return jsonb_build_object('ok', true, 'rows', n);
end $$;
revoke all on function jt.google_ads_ingest(jsonb) from public;

-- Called by the Google Ads script with the publishable key; the ingest key (Vault) is what lets it in.
create or replace function public.jt_google_ads_ingest(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare k text;
begin
  select decrypted_secret into k from vault.decrypted_secrets where name = 'google_ads_ingest_key';
  if k is null or coalesce(p->>'key', '') <> k then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.google_ads_ingest(p - 'key');
end $$;
revoke all on function public.jt_google_ads_ingest(jsonb) from public;
grant execute on function public.jt_google_ads_ingest(jsonb) to anon, authenticated;

-- the ingest key: made once, read it in Supabase → Vault to paste into the Google Ads script
do $$ begin
  if to_regclass('vault.secrets') is not null then        -- Supabase only (not the local test database)
    execute $q$ select vault.create_secret(encode(extensions.gen_random_bytes(24), 'hex'), 'google_ads_ingest_key', 'Google Ads script -> jt_google_ads_ingest')
                where not exists (select 1 from vault.secrets where name = 'google_ads_ingest_key') $q$;
  end if;
end $$;

create or replace view jt.v_sales_channels_daily as
with anr_orders as (select distinct order_id from jt.anr_sales where order_id <> 0),
jt_labels as (
  select coalesce(o.order_day, l.ship_date) as day, sum(l.cost) as cost
  from jt.shipstation_labels l left join jt.shopify_orders o on o.order_id = l.order_id
  where not l.voided and (l.order_id is null or l.order_id not in (select order_id from anr_orders))
  group by 1),
anr_labels as (select order_day as day, sum(label_cost) as cost from jt.v_anr_order_shipping group by 1),
veeqo as (select (v.order_created_at at time zone 'America/Los_Angeles')::date as day, sum(v.cost) as cost
          from jt.veeqo_shipments v where v.cost is not null and v.amazon_order_id <> '' group by 1),
units_jt as (select day, sum(units) as units, sum(cogs) as cogs, sum(net_no_cost) as net_no_cost from jt.v_product_sales_daily_costed group by day),
units_anr as (select day, sum(units) as units, sum(cogs) as cogs, sum(net_no_cost) as net_no_cost from jt.v_anr_sales_final group by day),
pay as (select store, day, sum(fee) as fee from jt.v_shopify_payment_fees group by 1, 2),
ads as (select store, day, sum(cost) as cost from jt.google_ads_daily group by 1, 2)
select s.day, 'justtennis'::text as channel, s.orders::numeric as orders, coalesce(u.units, 0) as units, s.net as net_sales,
       coalesce(u.cogs, s.cogs) as cogs, s.net - coalesce(u.net_no_cost, s.net_no_cost) - coalesce(u.cogs, s.cogs) as gross_profit,
       coalesce(u.net_no_cost, s.net_no_cost) as sales_no_cost,
       s.shipping as ship_charged, coalesce(l.cost, 0) as labels, 0::numeric as amz_fees, 0::numeric as fba_fees, 0::numeric as other_fees,
       s.net - coalesce(u.net_no_cost, s.net_no_cost) - coalesce(u.cogs, s.cogs) + s.shipping - coalesce(l.cost, 0) - coalesce(p.fee, 0) - coalesce(g.cost, 0) as profit,
       coalesce(p.fee, 0) as pay_fees, coalesce(g.cost, 0) as ad_spend
from jt.v_shopify_daily_costed s left join units_jt u on u.day = s.day left join jt_labels l on l.day = s.day
left join pay p on p.store = 'justtennis' and p.day = s.day
left join ads g on g.store = 'justtennis' and g.day = s.day
union all
select a.day, 'acenrally', a.orders::numeric, coalesce(u.units, 0), a.net, coalesce(u.cogs, a.cogs),
       a.net - coalesce(u.net_no_cost, a.net_no_cost) - coalesce(u.cogs, a.cogs), coalesce(u.net_no_cost, a.net_no_cost),
       a.shipping, coalesce(l.cost, 0), 0, 0, 0,
       a.net - coalesce(u.net_no_cost, a.net_no_cost) - coalesce(u.cogs, a.cogs) + a.shipping - coalesce(l.cost, 0) - coalesce(p.fee, 0) - coalesce(g.cost, 0), coalesce(p.fee, 0),
       coalesce(g.cost, 0)
from jt.v_anr_daily_costed a left join units_anr u on u.day = a.day left join anr_labels l on l.day = a.day
left join pay p on p.store = 'acenrally' and p.day = a.day
left join ads g on g.store = 'acenrally' and g.day = a.day
union all
select a.day, 'amazon', a.orders, a.units, a.sales, coalesce(c.cogs, 0), a.sales - coalesce(c.cogs, 0), coalesce(c.no_cost, 0),
       a.ship, -a.other_labels + coalesce(v.cost, 0), -a.sellfees, -a.fbafees, -(a.promo + a.refunds_net + a.other_rest),
       a.orders_net + a.refunds_net + a.other_labels + a.other_rest - coalesce(c.cogs, 0) - coalesce(v.cost, 0), 0::numeric, 0::numeric
from jt.amazon_order_daily a
left join lateral (select sum(k.units * m.cost) as cogs, sum(case when m.cost is null then k.sales else 0 end) as no_cost
                   from jt.amazon_sku_daily k left join jt.mv_amz_sku_cost m on m.sku = k.sku where k.day = a.day) c on true
left join veeqo v on v.day = a.day;


do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.google_ads_daily, jt.v_sales_channels_daily to jt_reader;
  end if;
end $$;
