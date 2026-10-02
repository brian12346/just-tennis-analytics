-- Supabase-only (not run by sync.migrate or the tests). Operational alerts (migration 060): run the rules every 15 minutes.
select cron.unschedule(jobname) from cron.job where jobname = 'jt-alerts';
select cron.schedule('jt-alerts', '*/15 * * * *', $$select jt.refresh_alerts()$$);
