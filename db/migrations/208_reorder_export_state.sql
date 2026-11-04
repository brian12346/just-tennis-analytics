-- 208: state for the `reorder-export` edge function (migration 207), kept in jt.settings 'reorder_export':
-- {date, written_at, report_id, pending_report, pending_date, files, error}. Called with null to read it, or with an
-- object whose keys are merged into it.

create or replace function public.jt_reorder_export_state(p jsonb default null)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare cur jsonb := coalesce((select value from jt.settings where key = 'reorder_export'), '{}'::jsonb);
begin
  if p is null then return cur; end if;
  insert into jt.settings (key, value) values ('reorder_export', cur || p)
  on conflict (key) do update set value = excluded.value;
  return cur || p;
end $function$;
revoke all on function public.jt_reorder_export_state(jsonb) from public, anon, authenticated;
grant execute on function public.jt_reorder_export_state(jsonb) to service_role;
