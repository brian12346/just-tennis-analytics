-- QuickBooks Online connection. The OAuth credentials live in Supabase Vault (qbo_client_id, qbo_client_secret,
-- qbo_refresh_token, qbo_realm_id). The `qbo` edge function talks to QuickBooks: it reads the credentials through
-- jt_qbo_creds(), refreshes the access token when needed and saves the new tokens back (jt_qbo_save_tokens) —
-- Intuit can hand out a new refresh token on each refresh. These functions are for the service role only.
--
-- Who may call the edge function: a signed-in app user (jt.app_users), or a caller holding the function key
-- (Vault jt_fn_key) — that's how SQL (jt.qbo_call, for the Claude dashboard and maintenance) reaches it.

-- (vault and pg_net exist on Supabase only; locally the key isn't created and the functions just fail if called)
do $$ begin
  if to_regnamespace('vault') is not null then
    execute $q$ select vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'jt_fn_key', 'key for calling jt edge functions from SQL')
      where not exists (select 1 from vault.secrets where name = 'jt_fn_key') $q$;
  end if;
end $$;

create or replace function public.jt_qbo_creds() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return (select jsonb_object_agg(name, decrypted_secret) from vault.decrypted_secrets
    where name in ('qbo_client_id', 'qbo_client_secret', 'qbo_refresh_token', 'qbo_realm_id', 'qbo_access_token', 'qbo_access_expires', 'qbo_env', 'jt_fn_key'));
end $$;

-- p = {refresh_token, access_token, access_expires, env} (any of them)
create or replace function public.jt_qbo_save_tokens(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
declare k text; v text; sid uuid;
begin
  foreach k in array array['refresh_token', 'access_token', 'access_expires', 'env'] loop
    v := p->>k; continue when v is null or v = '';
    select id into sid from vault.secrets where name = 'qbo_' || k;
    if sid is null then perform vault.create_secret(v, 'qbo_' || k);
    else perform vault.update_secret(sid, v); end if;
  end loop;
end $$;

create or replace function public.jt_qbo_allowed(uid uuid) returns boolean
language sql security definer set search_path = '' as $$ select exists (select 1 from jt.app_users where user_id = uid) $$;

revoke all on function public.jt_qbo_creds(), public.jt_qbo_save_tokens(jsonb), public.jt_qbo_allowed(uuid) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_qbo_creds(), public.jt_qbo_save_tokens(jsonb), public.jt_qbo_allowed(uuid) to service_role;
  end if;
end $$;

-- Calling the edge function from SQL (pg_net is asynchronous): jt.qbo_call returns a request id,
-- jt.qbo_result(id) returns {status, body} once the answer is in (null until then).
create or replace function jt.qbo_call(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/qbo', body := p, timeout_milliseconds := 30000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $$;
create or replace function jt.qbo_result(rid bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  return (select jsonb_build_object('status', status_code, 'error', error_msg, 'body', case when content ~ '^\s*[\{\[]' then content::jsonb else to_jsonb(content) end)
    from net._http_response where id = rid);
end $$;
revoke all on function jt.qbo_call(jsonb), jt.qbo_result(bigint) from public;

insert into jt.settings (key, value) values ('fn_base', jsonb_build_object('url', 'https://ppmzrlqvrhzfxobvnlon.supabase.co',
  'anon', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBwbXpybHF2cmh6ZnhvYnZubG9uIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzMDc1MDUsImV4cCI6MjEwNTg4MzUwNX0.Ktrcamlmx6ed_1ujf0ggR53LOAzfqnGktMtJXjTrHAg'))
on conflict (key) do update set value = excluded.value, updated_at = now();
