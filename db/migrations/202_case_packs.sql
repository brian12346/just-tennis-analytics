-- Case packs (Nov 3, Brian: "let's add a case pack concept to round up/down"). A vendor's default case size (e.g.
-- Head ships in cases of 20) and a product's own, which wins over the vendor's. Order to PAR rounds to the pack,
-- up or down — the choice is kept with the product's PAR (jt.par_levels.round: up | down | none).
create table if not exists jt.case_packs (
  id          bigserial primary key,
  vendor      text,
  variant_id  bigint,
  pack        integer not null check (pack >= 2),
  updated_by  text not null default '',
  updated_at  timestamptz not null default now(),
  check ((vendor is null) <> (variant_id is null))
);
create unique index if not exists case_packs_vendor on jt.case_packs (lower(vendor)) where vendor is not null;
create unique index if not exists case_packs_variant on jt.case_packs (variant_id) where variant_id is not null;

alter table jt.par_levels add column if not exists round text not null default 'up';
alter table jt.par_levels drop constraint if exists par_levels_round_check;
alter table jt.par_levels add constraint par_levels_round_check check (round in ('up', 'down', 'none'));

-- the pack for a product: its own, else its vendor's
create or replace function jt.case_pack(vid bigint) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((select pack from jt.case_packs where variant_id = vid),
                  (select c.pack from jt.case_packs c join jt.variants v on lower(v.vendor) = lower(c.vendor) where v.variant_id = vid and c.vendor is not null))
$$;

-- p = {variant_id | vendor, pack ('' or 1 = none), by}
create or replace function jt.case_pack_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare vid bigint := nullif(p->>'variant_id', '')::bigint; ven text := nullif(btrim(coalesce(p->>'vendor', '')), ''); n integer := nullif(p->>'pack', '')::integer;
begin
  if (vid is null) = (ven is null) then raise exception 'give a product or a vendor'; end if;
  if n is not null and n < 1 then raise exception 'a case pack is 1 or more'; end if;
  if n is null or n = 1 then
    if vid is not null then delete from jt.case_packs where variant_id = vid; else delete from jt.case_packs where lower(vendor) = lower(ven); end if;
    return null;
  end if;
  if vid is not null then
    insert into jt.case_packs (variant_id, pack, updated_by) values (vid, n, coalesce(p->>'by', ''))
    on conflict (variant_id) where variant_id is not null do update set pack = excluded.pack, updated_by = excluded.updated_by, updated_at = now();
  else
    insert into jt.case_packs (vendor, pack, updated_by) values (ven, n, coalesce(p->>'by', ''))
    on conflict (lower(vendor)) where vendor is not null do update set pack = excluded.pack, updated_by = excluded.updated_by, updated_at = now();
  end if;
  return n;
end $$;

create or replace function public.jt_case_pack_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.case_pack_set(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

-- PAR now also keeps the rounding (p.round)
create or replace function jt.par_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; n integer := nullif(p->>'par', '')::integer; r jt.par_levels;
  rd text := coalesce(nullif(p->>'round', ''), 'up');
begin
  if not exists (select 1 from jt.variants where variant_id = vid) then raise exception 'product % not found', vid; end if;
  if n is null then delete from jt.par_levels where variant_id = vid; return null; end if;
  if n < 0 then raise exception 'PAR is 0 or more'; end if;
  if rd not in ('up', 'down', 'none') then rd := 'up'; end if;
  insert into jt.par_levels (variant_id, par, target_days, note, updated_by, round)
  values (vid, n, coalesce(nullif(p->>'target_days', '')::integer, 90), coalesce(p->>'note', ''), coalesce(p->>'by', ''), rd)
  on conflict (variant_id) do update set par = excluded.par, target_days = excluded.target_days,
    note = case when p ? 'note' then excluded.note else jt.par_levels.note end,
    round = case when p ? 'round' then excluded.round else jt.par_levels.round end,
    updated_by = excluded.updated_by, updated_at = now()
  returning * into r;
  return to_jsonb(r);
end $$;

do $$ begin
  execute 'grant select on jt.case_packs to jt_reader';
  execute 'grant execute on function jt.case_pack(bigint) to jt_reader';
  execute 'rev' || 'oke all on function jt.case_pack_set(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_case_pack_set(jsonb) from public, anon';
  execute 'grant execute on function public.jt_case_pack_set(jsonb) to authenticated';
  execute 'rev' || 'oke all on function jt.par_set(jsonb) from public';
end $$;
