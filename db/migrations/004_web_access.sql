-- Web dashboard access (dashboard.andersenlifestyle.com).
-- The browser signs in with Supabase Auth and calls only the public.jt_* functions below.
-- Nothing in schema jt is exposed through the API; every function checks the caller is in jt.app_users.

-- Supabase's API roles (already there on Supabase; created here so plain Postgres test databases work too).
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end $$;

-- Documents the dashboard used to keep in the Claude artifact's storage (Amazon days/months/listings/mappings,
-- cost check log and alerts), one row per document.
create table if not exists jt.docs (
  collection  text not null,
  id          text not null,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  primary key (collection, id)
);

-- Who may use the dashboard (Supabase Auth user ids).
create table if not exists jt.app_users (
  user_id   uuid primary key,
  email     text not null,
  added_at  timestamptz not null default now()
);

create or replace function jt.is_app_user() returns boolean
language sql stable set search_path = '' as $$
  select exists (
    select 1 from jt.app_users
    where user_id = (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid
  );
$$;

-- Read-only role the query function runs as: it can read schema jt and nothing else of ours.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'jt_reader') then create role jt_reader nologin; end if;
end $$;
grant usage on schema jt to jt_reader;
grant select on all tables in schema jt to jt_reader;
alter default privileges in schema jt grant select on tables to jt_reader;
grant jt_reader to postgres;

-- Read queries from the dashboard. Runs as jt_reader, so it cannot change anything.
create or replace function public.jt_sql(q text) returns json
language plpgsql security definer set search_path = '' as $$
declare r json;
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if q !~* '^\s*(select|with)\s' then raise exception 'read queries only'; end if;
  set local statement_timeout = '25s';
  execute 'select coalesce(json_agg(t), ''[]''::json) from (' || q || ') t' into r;
  return r;
end $$;
-- changing the owner needs CREATE on schema public for a moment; taken back right after
grant create on schema public to jt_reader;
alter function public.jt_sql(text) owner to jt_reader;
revoke create on schema public from jt_reader;

-- Writes: one function per action, each checks the caller.
create or replace function public.jt_save_cost_overrides(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform jt.save_cost_override(x) from jsonb_array_elements(p) x;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.jt_delete_cost_override(p_order_id bigint) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform jt.delete_cost_override(p_order_id);
end $$;

create or replace function public.jt_doc_set(p_collection text, p_id text, p_data jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into jt.docs (collection, id, data, updated_at) values (p_collection, p_id, p_data, now())
  on conflict (collection, id) do update set data = excluded.data, updated_at = now();
end $$;

create or replace function public.jt_doc_delete(p_collection text, p_id text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  delete from jt.docs where collection = p_collection and id = p_id;
end $$;

-- Only signed-in users can call these (and each still checks jt.app_users).
revoke all on function public.jt_sql(text), public.jt_save_cost_overrides(jsonb), public.jt_delete_cost_override(bigint),
  public.jt_doc_set(text, text, jsonb), public.jt_doc_delete(text, text) from public, anon;
grant execute on function public.jt_sql(text), public.jt_save_cost_overrides(jsonb), public.jt_delete_cost_override(bigint),
  public.jt_doc_set(text, text, jsonb), public.jt_doc_delete(text, text) to authenticated;
