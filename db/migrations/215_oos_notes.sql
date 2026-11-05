-- Out of stock › Notes (Nov 5, Brian: "let's add a notes field on each row to leave ourselves little notes about status").
-- One note per product (variant), shown on its row in the out-of-stock list, To order and Ignored. An empty note clears it.
create table if not exists jt.oos_notes (
  variant_id  bigint primary key,
  note        text not null,
  by          text not null default '',
  at          timestamptz not null default now()
);

-- p = {variant_id, note, by}
create or replace function jt.oos_note(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; t text := left(btrim(coalesce(p->>'note', '')), 500);
begin
  if vid is null then raise exception 'variant_id is required'; end if;
  if t = '' then delete from jt.oos_notes where variant_id = vid; return false; end if;
  insert into jt.oos_notes (variant_id, note, by) values (vid, t, coalesce(p->>'by', ''))
  on conflict (variant_id) do update set note = excluded.note, by = excluded.by, at = now();
  return true;
end $$;

create or replace function public.jt_oos_note(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.oos_note(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

do $$ begin
  execute 'grant select on jt.oos_notes to jt_reader';
  execute 'rev' || 'oke all on function jt.oos_note(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_oos_note(jsonb) from public, anon';
  execute 'grant execute on function public.jt_oos_note(jsonb) to authenticated';
end $$;
