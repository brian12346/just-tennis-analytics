-- All sales › Today kept timing out (Brian, Oct 13): jt.v_sales_channels_daily works out every day of every channel
-- (4–7 s whatever range is asked for — the order, label, fee and cost views underneath are aggregated in full before
-- the date filter applies), and the web role's statement timeout is 8 s. The pages now read a stored copy,
-- jt.mv_sales_channels_daily, refreshed every 5 minutes by pg_cron (job jt-sales-channels) — the data under it changes
-- at most every few minutes anyway (Amazon every 10 min, Shopify hourly). as_of = when it was refreshed.
create materialized view if not exists jt.mv_sales_channels_daily as
select v.*, now() as as_of from jt.v_sales_channels_daily v;
create unique index if not exists mv_sales_channels_daily_key on jt.mv_sales_channels_daily (day, channel);

create or replace function jt.refresh_sales_channels() returns void
language plpgsql security definer set search_path = '' as $$
begin
  refresh materialized view concurrently jt.mv_sales_channels_daily;
end $$;
revoke all on function jt.refresh_sales_channels() from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.mv_sales_channels_daily to jt_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.mv_sales_channels_daily to fin_reader; end if;
  if exists (select 1 from pg_extension where extname = 'pg_cron') and not exists (select 1 from cron.job where jobname = 'jt-sales-channels') then
    perform cron.schedule('jt-sales-channels', '*/5 * * * *', 'select jt.refresh_sales_channels()');
  end if;
end $$;
