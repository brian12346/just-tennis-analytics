-- Ad spend from every platform in one place (Nov 17, Brian: "put google ads, meta, and chatgpt in the just tennis page —
-- let's figure out how to start filling in meta, amazon, and chatgpt ads after we get this ui going").
-- Google Ads already lands in jt.google_ads_daily (its own script, migration 105). Every other platform — Meta (Facebook
-- & Instagram), ChatGPT ads, Amazon Ads — lands here, one row per day, store, platform and campaign, from whatever feeds it
-- (an API sync, or a CSV upload) — none is connected yet. jt.v_ad_spend_daily is both together, which the pages read.
create table if not exists jt.ad_spend_daily (
  day          date not null,
  store        text not null,                 -- justtennis | acenrally | amazon
  platform     text not null,                 -- meta | chatgpt | amazon | …
  campaign_id  text not null default '',
  campaign     text not null default '',
  cost         numeric(12,2) not null default 0,
  clicks       integer not null default 0,
  impressions  integer not null default 0,
  conversions  numeric(12,2) not null default 0,
  conv_value   numeric(12,2) not null default 0,   -- the platform's own attributed sales
  source       text not null default '',          -- api | csv | manual
  synced_at    timestamptz not null default now(),
  primary key (day, store, platform, campaign_id)
);
create index if not exists ad_spend_daily_store_day on jt.ad_spend_daily (store, day);

create or replace view jt.v_ad_spend_daily as
  select day, store, 'google'::text as platform, campaign_id, campaign, cost, clicks, impressions, conversions, conv_value from jt.google_ads_daily
  union all
  select day, store, platform, campaign_id, campaign, cost, clicks, impressions, conversions, conv_value from jt.ad_spend_daily;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.ad_spend_daily, jt.v_ad_spend_daily to jt_reader;
  end if;
end $$;
