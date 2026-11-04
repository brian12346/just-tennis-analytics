-- Out of stock › Ignore (Nov 3, Brian: "in addition to archive, we need a way to ignore an out of stock item and put
-- it in a chart below so we can clear out the list regularly but not lose visibility"). An ignored product leaves the
-- list and shows in the Ignored table under it; it comes back if it goes to 0 again after it was ignored.
create table if not exists jt.oos_ignored (
  variant_id  bigint primary key,
  note        text not null default '',
  by          text not null default '',
  at          timestamptz not null default now()
);

-- p = {variant_id, on (default true), note, by}
create or replace function jt.oos_ignore(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint;
begin
  if coalesce((p->>'on')::boolean, true) then
    insert into jt.oos_ignored (variant_id, note, by) values (vid, coalesce(p->>'note', ''), coalesce(p->>'by', ''))
    on conflict (variant_id) do update set note = excluded.note, by = excluded.by, at = now();
    return true;
  end if;
  delete from jt.oos_ignored where variant_id = vid;
  return false;
end $$;

create or replace function public.jt_oos_ignore(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.oos_ignore(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

do $$ begin
  execute 'grant select on jt.oos_ignored to jt_reader';
  execute 'rev' || 'oke all on function jt.oos_ignore(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_oos_ignore(jsonb) from public, anon';
  execute 'grant execute on function public.jt_oos_ignore(jsonb) to authenticated';
end $$;
