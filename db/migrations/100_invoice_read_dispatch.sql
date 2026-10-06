-- The invoice reader runs inside the app (Brian, Oct 6): no standalone service. A queued read starts the GitHub
-- Actions workflow invoice-read.yml (pdftotext + tesseract + the template engine, sync/invoice_reader), which reads
-- everything queued, waits a couple of minutes for more, then stops. It connects with the sync's own DATABASE_URL,
-- so the separate invoice_reader login from the hand-off isn't needed.
--
-- jt.settings 'invoice_reader' = {seen_at}: the worker's heartbeat while it runs. A new read only starts the workflow
-- when no worker is running and none was started in the last 90 seconds (a started one picks it up when it begins).

create or replace function jt.dispatch_invoice_read() returns bigint
language plpgsql security definer set search_path = '' as $$
declare tok text; rid bigint; seen timestamptz;
begin
  select (value->>'seen_at')::timestamptz into seen from jt.settings where key = 'invoice_reader';
  if seen > now() - interval '20 seconds' then return null; end if;                         -- a worker is listening
  if exists (select 1 from jt.sync_dispatches where job = 'invoice-read' and requested_at > now() - interval '90 seconds') then return null; end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regprocedure('net.http_post(text,jsonb,jsonb,jsonb,integer)') is null then
    insert into jt.sync_dispatches (job, note) values ('invoice-read', 'no vault/pg_net here'); return null;
  end if;
  execute $q$select decrypted_secret from vault.decrypted_secrets where name = 'github_dispatch_token' limit 1$q$ into tok;
  if tok is null or tok = '' then
    insert into jt.sync_dispatches (job, note) values ('invoice-read', 'no github_dispatch_token in Vault'); return null;
  end if;
  execute $q$select net.http_post(
    url     := 'https://api.github.com/repos/brian12346/just-tennis-analytics/actions/workflows/invoice-read.yml/dispatches',
    body    := jsonb_build_object('ref', 'main'),
    headers := jsonb_build_object('Authorization', 'Bearer ' || $1, 'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28', 'User-Agent', 'just-tennis-supabase', 'Content-Type', 'application/json'),
    timeout_milliseconds := 10000)$q$ into rid using tok;
  insert into jt.sync_dispatches (job, request_id, note) values ('invoice-read', rid, 'invoice reader');
  return rid;
end $$;
revoke all on function jt.dispatch_invoice_read() from public;

create or replace function jt.invoice_reads_dispatch_trg() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'queued' then
    begin perform jt.dispatch_invoice_read();
    exception when others then null;                       -- never block an upload over the workflow start
    end;
  end if;
  return null;
end $$;
create or replace trigger invoice_reads_dispatch after insert or update of status on jt.invoice_reads
  for each row when (new.status = 'queued') execute function jt.invoice_reads_dispatch_trg();
