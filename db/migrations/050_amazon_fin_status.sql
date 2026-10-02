-- When Amazon fees/profit (Finances API) were last brought in, for the Amazon tab's status line.
create or replace view jt.v_amazon_api_status as
select (select max(requested_at) from jt.amazon_reports where kind = 'recent' and status = 'done') as as_of,
       (select max(processed_at) from jt.amazon_reports where status = 'done')                      as last_saved,
       (select count(*) from jt.amazon_reports where status in ('requested', 'queued'))           as waiting,
       (select count(*) from jt.amazon_reports where status = 'failed' and requested_at > now() - interval '1 day') as failed_today,
       (select min((purchase_at at time zone 'America/Los_Angeles')::date) from jt.amazon_order_lines) as first_day,
       (select max((purchase_at at time zone 'America/Los_Angeles')::date) from jt.amazon_order_lines) as last_day,
       (select max(updated_at) from jt.amazon_fin_lines)                                            as fin_as_of;
