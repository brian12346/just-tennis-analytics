-- Faster Amazon order views: the exchange rates are read once per query instead of once per line, and there's an
-- index on the Pacific purchase day so a date range reads only its own lines.
create index if not exists amazon_order_lines_day on jt.amazon_order_lines (((purchase_at at time zone 'America/Los_Angeles')::date));

create or replace view jt.v_amazon_api_lines as
select l.*,
       (l.purchase_at at time zone 'America/Los_Angeles')::date as day,
       coalesce((fx.value ->> l.currency)::numeric, case when l.currency in ('', 'USD') then 1 end) as fx,
       round(l.item_price * coalesce((fx.value ->> l.currency)::numeric, case when l.currency in ('', 'USD') then 1 end), 2) as sales_usd,
       round((l.item_price + l.item_promo) * coalesce((fx.value ->> l.currency)::numeric, case when l.currency in ('', 'USD') then 1 end), 2) as net_sales_usd
from jt.amazon_order_lines l
left join jt.settings fx on fx.key = 'amazon_fx'
where l.marketplace in ('us', 'ca', 'mx')
  and l.order_status <> 'Cancelled' and l.item_status <> 'Cancelled';

-- When the orders were last brought in from Amazon (the time the newest finished "recent" report was asked for),
-- and whether one is on its way.
create or replace view jt.v_amazon_api_status as
select (select max(requested_at) from jt.amazon_reports where kind = 'recent' and status = 'done') as as_of,
       (select max(processed_at) from jt.amazon_reports where status = 'done')                      as last_saved,
       (select count(*) from jt.amazon_reports where status = 'requested')                        as waiting,
       (select count(*) from jt.amazon_reports where status = 'failed' and requested_at > now() - interval '1 day') as failed_today,
       (select min((purchase_at at time zone 'America/Los_Angeles')::date) from jt.amazon_order_lines) as first_day,
       (select max((purchase_at at time zone 'America/Los_Angeles')::date) from jt.amazon_order_lines) as last_day;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.v_amazon_api_lines, jt.v_amazon_api_status to jt_reader;
  end if;
end $$;
