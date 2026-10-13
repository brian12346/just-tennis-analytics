-- Finance › Profit history starts Oct 1, 2024 (Brian, Oct 13), like the sales history: the daily P&L sync asks
-- QuickBooks from then on (the page's Refresh does too). Months before the start are never cleared by a sync.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    if exists (select 1 from cron.job where jobname = 'fin-qbo-pl') then perform cron.unschedule('fin-qbo-pl'); end if;
    perform cron.schedule('fin-qbo-pl', '20 13 * * *', $c$select jt.qbo_call('{"action":"pl_sync","start":"2024-10-01"}'::jsonb)$c$);
  end if;
end $$;
