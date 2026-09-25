-- Supabase-only (not run by sync.migrate or the tests; apply in the Supabase SQL editor or via the connector).
--
-- GitHub's own cron is best-effort and often skips hours on a small repo. Instead, Supabase's scheduler (pg_cron)
-- asks GitHub to start the "Sync data" workflow on demand (workflow_dispatch), which starts within seconds.
--
-- Needs a GitHub fine-grained token that can only run this repo's workflows (Actions: read and write), stored in the
-- Supabase Vault under the name 'github_dispatch_token':
--   select vault.create_secret('<token>', 'github_dispatch_token', 'Starts the Sync data workflow');
-- To replace it later:
--   select vault.update_secret((select id from vault.secrets where name = 'github_dispatch_token'), '<new token>');

create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

create table if not exists jt.sync_dispatches (
  id           bigserial primary key,
  job          text not null,
  requested_at timestamptz not null default now(),
  request_id   bigint,               -- pg_net request id (response in net._http_response for a few hours)
  note         text not null default ''
);

create or replace function jt.dispatch_sync(p_job text default 'hourly') returns bigint
language plpgsql security definer set search_path = '' as $$
declare
  tok text;
  rid bigint;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if tok is null or tok = '' then
    insert into jt.sync_dispatches (job, note) values (p_job, 'no github_dispatch_token in Vault');
    return null;
  end if;
  select net.http_post(
    url     := 'https://api.github.com/repos/brian12346/just-tennis-analytics/actions/workflows/sync.yml/dispatches',
    body    := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('job', p_job)),
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'just-tennis-supabase',
      'Content-Type', 'application/json'),
    timeout_milliseconds := 10000
  ) into rid;
  insert into jt.sync_dispatches (job, request_id) values (p_job, rid);
  return rid;
end $$;
revoke all on function jt.dispatch_sync(text) from public, anon, authenticated;

-- Last few dispatches with GitHub's answer (204 = started). pg_net keeps responses for about 6 hours.
create or replace view jt.v_sync_dispatches as
select d.requested_at, d.job, d.note, r.status_code, left(coalesce(r.content, r.error_msg, ''), 200) as response
from jt.sync_dispatches d
left join net._http_response r on r.id = d.request_id
order by d.requested_at desc;

-- Hourly at :07 (recent sales, orders, labels); nightly at 11:30 UTC = 4:30am Pacific (catalog, cost check, 35-day re-sync).
select cron.unschedule(jobname) from cron.job where jobname in ('jt-sync-hourly', 'jt-sync-nightly');
select cron.schedule('jt-sync-hourly', '7 * * * *', $$select jt.dispatch_sync('hourly')$$);
select cron.schedule('jt-sync-nightly', '30 11 * * *', $$select jt.dispatch_sync('nightly')$$);
