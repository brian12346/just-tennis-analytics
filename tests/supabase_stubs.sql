-- Stand-ins for the Supabase-only pieces some migrations touch, so the whole migration set applies to a plain Postgres
-- test database (CI's postgres:16). Run by tests/conftest.py before sync.migrate. Not used in production.
-- pg_cron: migrations only schedule jobs when the extension exists; some guards also read cron.job.
create schema if not exists cron;
create table if not exists cron.job (jobid bigserial primary key, jobname text, schedule text, command text, active boolean default true);
create or replace function cron.schedule(job_name text, schedule text, command text) returns bigint language sql as $$
  insert into cron.job (jobname, schedule, command) values (job_name, schedule, command) returning jobid $$;
create or replace function cron.unschedule(job_name text) returns boolean language sql as $$
  update cron.job set active = false where jobname = job_name returning true $$;
-- Storage: buckets and the objects table that policies are created on
create schema if not exists storage;
create table if not exists storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[],
  created_at timestamptz default now());
create table if not exists storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid,
  metadata jsonb, created_at timestamptz default now());
alter table storage.objects enable row level security;
-- db/supabase/sync_scheduler.sql (Supabase-only) makes jt.sync_dispatches; a few migrations read it in SQL functions
create schema if not exists jt;
create table if not exists jt.sync_dispatches (id bigserial primary key, job text not null, requested_at timestamptz not null default now(),
  request_id bigint, note text not null default '');
-- pg_net: requests are recorded, nothing is sent
create schema if not exists net;
create table if not exists net._http_response (id bigserial primary key, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz not null default now());
create table if not exists net.http_request_queue (id bigserial primary key, method text, url text, headers jsonb, body jsonb, timeout_milliseconds integer);
create or replace function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000) returns bigint language sql as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds) values ('POST', url, headers, body, timeout_milliseconds) returning id $$;
create or replace function net.http_get(url text, params jsonb default '{}'::jsonb, headers jsonb default '{}'::jsonb,
  timeout_milliseconds integer default 5000) returns bigint language sql as $$
  insert into net.http_request_queue (method, url, headers, timeout_milliseconds) values ('GET', url, headers, timeout_milliseconds) returning id $$;
-- Vault: secrets kept in plain text (test database only)
create schema if not exists vault;
create table if not exists vault.secrets (id uuid primary key default gen_random_uuid(), name text unique, secret text, description text default '',
  created_at timestamptz default now(), updated_at timestamptz default now());
create or replace view vault.decrypted_secrets as select id, name, secret as decrypted_secret, description, created_at, updated_at from vault.secrets;
create or replace function vault.create_secret(new_secret text, new_name text default null, new_description text default '') returns uuid language sql as $$
  insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id $$;
create or replace function vault.update_secret(secret_id uuid, new_secret text default null, new_name text default null, new_description text default null)
  returns void language sql as $$
  update vault.secrets set secret = coalesce(new_secret, secret), name = coalesce(new_name, name), description = coalesce(new_description, description),
    updated_at = now() where id = secret_id $$;
-- pgcrypto lives in the extensions schema on Supabase
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
-- Supabase's API roles (004_web_access.sql makes anon / authenticated when missing; service_role it doesn't)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
end $$;
