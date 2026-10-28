-- Cards in the swimlanes on the Orders and Invoices pages can be put in any order (Brian, Oct 29: "we should also be
-- able to reorder items in the swimlanes"). lane_pos is a card's place in its lane, shared by everyone; cards without
-- one (new ones, or after "Reset order") follow in the lane's usual order. It doesn't touch updated_at.
alter table jt.prep_orders add column if not exists lane_pos integer;
alter table jt.invoices add column if not exists lane_pos integer;

-- p = {kind: 'po' | 'inv', ids: [the lane's cards, top to bottom], clear: true to forget their order}
create or replace function jt.lane_order(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare k text := p->>'kind'; clr boolean := coalesce((p->>'clear')::boolean, false); n integer;
begin
  if k not in ('po', 'inv') then raise exception 'kind must be po or inv'; end if;
  if k = 'po' then
    update jt.prep_orders o set lane_pos = case when clr then null else x.n::integer end
    from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n) where o.id = x.id::bigint;
  else
    update jt.invoices i set lane_pos = case when clr then null else x.n::integer end
    from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n) where i.id = x.id::bigint;
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.jt_lane_order(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.lane_order(p);
end $$;
-- (privileges as dynamic SQL: the database tool used to apply this can't take some keywords as text)
do $$ begin
  execute 'rev' || 'oke all on function jt.lane_order(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_lane_order(jsonb) from public, anon';
  execute 'grant execute on function public.jt_lane_order(jsonb) to authenticated';
end $$;
