-- Prep center › Analyze (Brian, Oct 8): finds stock (prep center, then the Shopify store) to send to Amazon by days of
-- cover. Listings the user ignores are kept here until a date (or until cleared), so the next run leaves them out.

create table if not exists jt.send_finder_ignore (
  id          bigint generated always as identity primary key,
  amazon_sku  text not null,
  until       date,                                  -- null = until cleared
  note        text not null default '',
  added_at    timestamptz not null default now(),
  added_by    text not null default '',
  cleared_at  timestamptz
);
create unique index if not exists send_finder_ignore_open on jt.send_finder_ignore (amazon_sku) where cleared_at is null;

-- p = {skus: [...], days: 30 | null (until cleared), clear: true|false, note?, by}
create or replace function jt.send_finder_ignore_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare k text; n int := 0; who text := coalesce(p->>'by', ''); d int := nullif(p->>'days', '')::int;
begin
  for k in select jsonb_array_elements_text(coalesce(p->'skus', '[]'::jsonb)) loop
    update jt.send_finder_ignore set cleared_at = now() where amazon_sku = k and cleared_at is null;
    if not coalesce((p->>'clear')::boolean, false) then
      insert into jt.send_finder_ignore (amazon_sku, until, note, added_by)
      values (k, case when d is null then null else (now() at time zone 'America/Los_Angeles')::date + d end, coalesce(p->>'note', ''), who);
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;
revoke all on function jt.send_finder_ignore_set(jsonb) from public;

create or replace function public.jt_send_finder_ignore_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.send_finder_ignore_set(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_send_finder_ignore_set(jsonb) from public, anon;
grant execute on function public.jt_send_finder_ignore_set(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.send_finder_ignore to jt_reader;
  end if;
end $$;
