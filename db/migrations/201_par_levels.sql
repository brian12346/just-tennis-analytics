-- PAR levels (Nov 3, Brian: "on the analysis we should do a pop up with sales data, target days on hand, par level,
-- etc. let's enable a way to set a PAR level, order to PAR or adjust PAR level"). One per Shopify variant: the stock to
-- hold in the store, and the days of sales it was sized for (default 90 — "hold 3 months of stock").
-- Order to PAR = PAR − on hand − on order (open POs), set as the To order quantity.
create table if not exists jt.par_levels (
  variant_id   bigint primary key,
  par          integer not null check (par >= 0),
  target_days  integer not null default 90 check (target_days between 1 and 730),
  note         text not null default '',
  updated_by   text not null default '',
  updated_at   timestamptz not null default now()
);

-- p = {variant_id, par (null = clear), target_days, note, by}
create or replace function jt.par_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; n integer := nullif(p->>'par', '')::integer; r jt.par_levels;
begin
  if not exists (select 1 from jt.variants where variant_id = vid) then raise exception 'product % not found', vid; end if;
  if n is null then delete from jt.par_levels where variant_id = vid; return null; end if;
  if n < 0 then raise exception 'PAR is 0 or more'; end if;
  insert into jt.par_levels (variant_id, par, target_days, note, updated_by)
  values (vid, n, coalesce(nullif(p->>'target_days', '')::integer, 90), coalesce(p->>'note', ''), coalesce(p->>'by', ''))
  on conflict (variant_id) do update set par = excluded.par, target_days = excluded.target_days,
    note = case when p ? 'note' then excluded.note else jt.par_levels.note end, updated_by = excluded.updated_by, updated_at = now()
  returning * into r;
  return to_jsonb(r);
end $$;

create or replace function public.jt_par_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.par_set(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

do $$ begin
  execute 'grant select on jt.par_levels to jt_reader';
  execute 'rev' || 'oke all on function jt.par_set(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_par_set(jsonb) from public, anon';
  execute 'grant execute on function public.jt_par_set(jsonb) to authenticated';
end $$;
