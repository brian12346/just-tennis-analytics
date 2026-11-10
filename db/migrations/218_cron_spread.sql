-- Spread the heavy hourly jobs (Nov 10, Brian: "having a hard time loading the finance page"). Around :40–:46 the reorder
-- export build (about 22 s), the Amazon order sync (*/10, its state read was timing out at :40 every hour), the alerts
-- refresh (*/15) and the sales-channels refresh (*/5) overlapped; on Nov 10 at 17:45 UTC the alerts and sales-channels
-- refreshes took 58 s and 78 s and six Finance reads hit the 8-second limit. Now the export build runs at :52 and the
-- alerts at :02, :17, :32 and :47, away from the :00/:15/:30/:45 sales-channels runs and the :40 Amazon sync.
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('jt-reorder-export-build', '52 * * * *', $c$select jt.reorder_export_build()$c$);
    perform cron.schedule('jt-alerts', '2,17,32,47 * * * *', $c$select jt.refresh_alerts()$c$);
  end if;
end $$;
