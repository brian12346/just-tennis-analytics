-- Supabase-only (not run by sync.migrate or the tests). Finance dashboard (migration 062): QuickBooks payables into
-- schema fin every hour at :35 (only what changed; a full pass once a week).
select cron.unschedule(jobname) from cron.job where jobname = 'fin-qbo-payables';
select cron.schedule('fin-qbo-payables', '35 * * * *', $$select jt.qbo_call('{"action":"payables_sync"}'::jsonb)$$);
