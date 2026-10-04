-- Start a sync job with a start date (workflow input "since"), e.g. select jt.dispatch_sync('acenrally', '2025-01-01')
-- to load Ace n Rally's history. Same as jt.dispatch_sync(text) otherwise; callable only by the database owner.
create or replace function jt.dispatch_sync(p_job text, p_since date) returns bigint
language plpgsql security definer set search_path = '' as $$
declare tok text; rid bigint;
begin
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1;
  if tok is null or tok = '' then
    insert into jt.sync_dispatches (job, note) values (p_job, 'no github_dispatch_token in Vault');
    return null;
  end if;
  select net.http_post(
    url     := 'https://api.github.com/repos/brian12346/just-tennis-analytics/actions/workflows/sync.yml/dispatches',
    body    := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('job', p_job, 'since', p_since::text)),
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'just-tennis-supabase', 'Content-Type', 'application/json'),
    timeout_milliseconds := 10000) into rid;
  insert into jt.sync_dispatches (job, request_id, note) values (p_job, rid, 'since ' || p_since);
  return rid;
end $$;
revoke all on function jt.dispatch_sync(text, date) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function jt.dispatch_sync(text, date) from anon, authenticated; end if;
end $$;
