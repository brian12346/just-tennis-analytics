-- Dashboard access by email (Brian, Oct 8): an email on jt.app_user_invites gets dashboard access (jt.app_users) as
-- soon as its Supabase Auth login exists (created in Supabase → Authentication → Users). Finance access is separate
-- (fin.users) and is never granted from here. First invite: brittany@justtennis.com (dashboard, no finance).

create table if not exists jt.app_user_invites (
  email       text primary key,                   -- lower case
  note        text not null default '',
  invited_at  timestamptz not null default now(),
  invited_by  text not null default ''
);

-- add every invited email that has a login and isn't on the list yet; returns how many were added
create or replace function jt.app_users_from_invites() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0;
begin
  if to_regclass('auth.users') is null then return 0; end if;
  execute $q$ insert into jt.app_users (user_id, email)
    select u.id, lower(u.email) from auth.users u join jt.app_user_invites i on i.email = lower(u.email)
    on conflict (user_id) do nothing $q$;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function jt.app_users_from_invites() from public;

-- when a login is created (or its email confirmed / changed), pick up the invite
create or replace function jt.app_user_on_auth() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform jt.app_users_from_invites();
  return null;
end $$;
revoke all on function jt.app_user_on_auth() from public;

do $$ begin
  if to_regclass('auth.users') is not null then
    execute 'create or replace trigger jt_app_user_on_auth after insert or update of email, email_confirmed_at on auth.users
             for each statement execute function jt.app_user_on_auth()';
  end if;
end $$;

insert into jt.app_user_invites (email, note, invited_by) values ('brittany@justtennis.com', 'dashboard, no finance', 'brian@justtennis.com')
on conflict (email) do nothing;
select jt.app_users_from_invites();
