-- Prep center "Analyze" (Brian, Oct 7): products in Incoming shipments can be set aside to look at more closely before
-- an Amazon shipment is made. One open flag per product + Amazon listing; done_at closes it (kept for history).

create table if not exists jt.prep_analyze (
  id          bigint generated always as identity primary key,
  variant_id  bigint not null,
  amazon_sku  text not null default '',
  note        text not null default '',
  added_at    timestamptz not null default now(),
  added_by    text not null default '',
  done_at     timestamptz,
  done_by     text not null default ''
);
create unique index if not exists prep_analyze_open on jt.prep_analyze (variant_id, amazon_sku) where done_at is null;

-- p = {variant_id, amazon_sku, on: true|false, note?, by}. on = true adds (or updates the note of) the open flag;
-- on = false closes it.
create or replace function jt.prep_analyze_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; sku text := coalesce(p->>'amazon_sku', ''); who text := coalesce(p->>'by', '');
begin
  if vid is null then raise exception 'variant_id is required'; end if;
  if coalesce((p->>'on')::boolean, true) then
    update jt.prep_analyze set note = coalesce(p->>'note', note) where variant_id = vid and amazon_sku = sku and done_at is null;
    if not found then
      insert into jt.prep_analyze (variant_id, amazon_sku, note, added_by) values (vid, sku, coalesce(p->>'note', ''), who);
    end if;
  else
    update jt.prep_analyze set done_at = now(), done_by = who where variant_id = vid and amazon_sku = sku and done_at is null;
  end if;
  return true;
end $$;
revoke all on function jt.prep_analyze_set(jsonb) from public;

create or replace function public.jt_prep_analyze_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_analyze_set(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_analyze_set(jsonb) from public, anon;
grant execute on function public.jt_prep_analyze_set(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.prep_analyze to jt_reader;
  end if;
end $$;
