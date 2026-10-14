-- To do list: each person's own, semi-private (Brian, Oct 14: "this should be each user's to do list and it should be
-- semi private" → "Mine + what I assigned"). A signed-in person sees the to-dos they own plus the ones they gave
-- someone else; nobody can browse another person's list. Only the owner or the person who assigned a to-do can change
-- it. Owners are Seller Sage users (their email). Seller Sage suggestions stay shared, with who has each one.
--
-- The web app reads through jt_sql (role jt_reader), so jt_reader no longer reads jt.todos directly: it reads
-- jt.todo_visible(), which works out who's asking from the sign-in. Without a sign-in (Claude, the database itself) it
-- returns every to-do.

-- who's signed in (null for Claude / the database)
create or replace function jt.me() returns text
language sql stable security definer set search_path = '' as $$
  select u.email from jt.app_users u
  where u.user_id = (nullif(current_setting('request.jwt.claims', true), '')::json ->> 'sub')::uuid
$$;
revoke all on function jt.me() from public;

create or replace function jt.todo_visible()
returns setof jt.todos
language sql stable security definer set search_path = '' as $$
  select t.* from jt.todos t, (select jt.me() as me) w
  where w.me is null or lower(t.owner) = lower(w.me) or lower(t.created_by) = lower(w.me)
$$;
revoke all on function jt.todo_visible() from public;

-- the suggestions, and who has each one as a to-do already (owner's email, or null)
create or replace function jt.todo_suggest()
returns table (key text, kind text, title text, link text, detail text, since timestamptz, taken_by text)
language sql stable security definer set search_path = '' as $$
  select s.key, s.kind, s.title, s.link, s.detail, s.since,
         (select t.owner from jt.todos t where t.source = s.key and t.done_at is null limit 1)
  from jt.todo_suggestions() s
$$;
revoke all on function jt.todo_suggest() from public;

-- the web app's writes: the owner must be a Seller Sage user (blank = me); a change needs to be mine or assigned by me
create or replace function jt.todo_mine(tid bigint, me text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from jt.todos t where t.id = tid and (lower(t.owner) = lower(me) or lower(t.created_by) = lower(me)))
$$;
revoke all on function jt.todo_mine(bigint, text) from public;

create or replace function public.jt_todo_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare me text := jt.me(); who text := lower(btrim(coalesce(p->>'owner', '')));
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if who = '' then who := lower(me); end if;
  if not exists (select 1 from jt.app_users u where lower(u.email) = who) then raise exception 'a to-do goes to a Seller Sage user'; end if;
  if nullif(p->>'id', '') is not null and not jt.todo_mine((p->>'id')::bigint, me) then raise exception 'that to-do isn''t yours' using errcode = '42501'; end if;
  return jt.todo_save(p || jsonb_build_object('owner', who, 'by', lower(me)));
end $$;
create or replace function public.jt_todo_done(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me text := jt.me();
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if not jt.todo_mine((p->>'id')::bigint, me) then raise exception 'that to-do isn''t yours' using errcode = '42501'; end if;
  return jt.todo_done(p || jsonb_build_object('by', lower(me)));
end $$;
create or replace function public.jt_todo_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare me text := jt.me();
begin
  if me is null then raise exception 'not allowed' using errcode = '42501'; end if;
  if not jt.todo_mine((p->>'id')::bigint, me) then raise exception 'that to-do isn''t yours' using errcode = '42501'; end if;
  return jt.todo_delete(p);
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    revoke select on jt.todos from jt_reader;
    grant execute on function jt.todo_visible(), jt.todo_suggest(), jt.me() to jt_reader;
  end if;
end $$;
