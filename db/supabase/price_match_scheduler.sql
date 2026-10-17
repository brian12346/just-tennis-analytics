-- Price match (migration 152): run in the Supabase SQL editor (or via the MCP) once; pg_cron jobs live outside migrations.
-- Amazon Buy Box prices: every 3 minutes from 2:00 to 5:57 am PDT (09–12 UTC); each call works ~2 minutes, then stops
-- (a no-op once everything is fresh). The price-match sync job: 12:30 UTC = 5:30 am PDT (4:30 am PST).
select cron.schedule('jt-pm-amazon', '*/3 9-12 * * *', $$select jt.pm_amazon_call('{"action":"buybox"}'::jsonb)$$);
select cron.schedule('jt-price-match', '30 12 * * *', $$select jt.dispatch_sync('price-match')$$);
