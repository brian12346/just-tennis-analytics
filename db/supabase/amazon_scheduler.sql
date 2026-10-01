-- Supabase-only (not run by sync.migrate or the tests; apply in the Supabase SQL editor or via the connector).
--
-- Amazon orders (SP-API): every 10 minutes pg_cron calls the `amazon` edge function with {action: "sync"}.
-- Each call picks up order reports Amazon has finished; about once an hour it also asks for a new report of orders
-- changed in the last 3 days. So orders show up in the dashboard within about an hour, and status changes
-- (pending -> shipped, cancellations) are caught for 3 days.
select cron.unschedule(jobname) from cron.job where jobname = 'jt-amazon-orders';
select cron.schedule('jt-amazon-orders', '*/10 * * * *', $$select jt.amazon_call('{"action":"sync"}'::jsonb)$$);
