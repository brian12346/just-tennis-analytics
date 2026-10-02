-- Supabase-only (not run by sync.migrate or the tests; apply in the Supabase SQL editor or via the connector).
--
-- Amazon orders (SP-API): every 10 minutes pg_cron calls the `amazon` edge function with {action: "sync"}.
-- Each call picks up order reports Amazon has finished; about once an hour it also asks for a new report of orders
-- changed in the last 3 days. So orders show up in the dashboard within about an hour, and status changes
-- (pending -> shipped, cancellations) are caught for 3 days.
select cron.unschedule(jobname) from cron.job where jobname = 'jt-amazon-orders';
select cron.schedule('jt-amazon-orders', '*/10 * * * *', $$select jt.amazon_call('{"action":"sync"}'::jsonb)$$);

-- Amazon money (Finances API): yesterday and today every hour at :20, and the last 7 days nightly at 11:50 UTC
-- (4:50am Pacific) to catch anything Amazon posts late. Each run rewrites those days on the Amazon tab.
select cron.unschedule(jobname) from cron.job where jobname in ('jt-amazon-fin-recent', 'jt-amazon-fin-nightly');
select cron.schedule('jt-amazon-fin-recent', '20 * * * *', $$select jt.amazon_call('{"action":"fin_recent"}'::jsonb)$$);
select cron.schedule('jt-amazon-fin-nightly', '50 11 * * *', $$select jt.amazon_call('{"action":"fin_nightly"}'::jsonb)$$);

-- FBA inventory (FBA Inventory API, migration 066): every hour at :05 into jt.fba_inventory.
select cron.unschedule(jobname) from cron.job where jobname = 'jt-amazon-fba';
select cron.schedule('jt-amazon-fba', '5 * * * *', $$select jt.amazon_call('{"action":"fba_inventory"}'::jsonb)$$);

-- Units per ASIN per day for the FBA forecast (migration 067): the last 4 days every hour at :12 (after the order
-- syncs), the last 5 weeks nightly at 12:10 UTC.
select cron.unschedule(jobname) from cron.job where jobname in ('jt-asin-daily', 'jt-asin-daily-nightly');
select cron.schedule('jt-asin-daily', '12 * * * *', $$select jt.refresh_asin_daily((now() at time zone 'America/Los_Angeles')::date - 4)$$);
select cron.schedule('jt-asin-daily-nightly', '10 12 * * *', $$select jt.refresh_asin_daily((now() at time zone 'America/Los_Angeles')::date - 35)$$);

-- FBA and AWD inbound shipments (migration 068): shipments updated in the last 3 days, every hour at :25.
select cron.unschedule(jobname) from cron.job where jobname = 'jt-amazon-inbound';
select cron.schedule('jt-amazon-inbound', '25 * * * *', $$select jt.amazon_call('{"action":"inbound_shipments"}'::jsonb)$$);
