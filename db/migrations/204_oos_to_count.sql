-- Out of stock › To count (Nov 3, Brian: "let's add a way to put items back in the top screen - maybe call it 'to
-- count' and then put it back on the list above"). From Ignored, or from To order (while it isn't on a PO), a product
-- goes back on the out-of-stock list to be counted — even if it went to 0 more than 7 days ago. It stays there until
-- it's counted above 0, ignored again, reordered or archived.
create table if not exists jt.oos_recount (
  variant_id  bigint primary key,
  by          text not null default '',
  at          timestamptz not null default now()
);

-- p = {variant_id, by}
create or replace function jt.oos_to_count(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; i record;
begin
  if not exists (select 1 from jt.variants where variant_id = vid) then raise exception 'product % not found', vid; end if;
  for i in select * from jt.prep_list where variant_id = vid and dest = 'shopify' and closed_at is null loop
    if i.order_id is not null then raise exception 'it''s on a PO — take it off the PO first'; end if;
    perform jt.prep_list_remove(jsonb_build_object('id', i.id));
  end loop;
  delete from jt.oos_ignored where variant_id = vid;
  insert into jt.oos_recount (variant_id, by) values (vid, coalesce(p->>'by', ''))
  on conflict (variant_id) do update set by = excluded.by, at = now();
  return true;
end $$;

create or replace function public.jt_oos_to_count(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.oos_to_count(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

-- ignoring it again takes it off To count
create or replace function jt.oos_ignore(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint;
begin
  if coalesce((p->>'on')::boolean, true) then
    insert into jt.oos_ignored (variant_id, note, by) values (vid, coalesce(p->>'note', ''), coalesce(p->>'by', ''))
    on conflict (variant_id) do update set note = excluded.note, by = excluded.by, at = now();
    delete from jt.oos_recount where variant_id = vid;
    return true;
  end if;
  delete from jt.oos_ignored where variant_id = vid;
  return false;
end $$;

do $$ begin
  execute 'grant select on jt.oos_recount to jt_reader';
  execute 'rev' || 'oke all on function jt.oos_to_count(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_oos_to_count(jsonb) from public, anon';
  execute 'grant execute on function public.jt_oos_to_count(jsonb) to authenticated';
  execute 'rev' || 'oke all on function jt.oos_ignore(jsonb) from public';
end $$;
