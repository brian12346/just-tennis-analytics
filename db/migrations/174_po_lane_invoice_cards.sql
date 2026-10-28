-- The Orders swimlanes show each invoice on an order as its own card (Brian, Oct 29: "the order should be able to
-- straddle states if it has been invoiced but there are parts of the order that haven't been invoiced"). Those cards
-- can be put in order too; their place on the Orders page is po_lane_pos (lane_pos stays the Invoices page's order).
alter table jt.invoices add column if not exists po_lane_pos integer;

-- kind 'po' now takes card keys: 'o12' (order 12) or 'i34' (invoice 34); a bare number is still an order.
create or replace function jt.lane_order(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare k text := p->>'kind'; clr boolean := coalesce((p->>'clear')::boolean, false); n integer; m integer;
begin
  if k not in ('po', 'inv') then raise exception 'kind must be po or inv'; end if;
  if k = 'po' then
    update jt.prep_orders o set lane_pos = case when clr then null else x.n::integer end
    from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n)
    where x.id !~ '^i' and o.id = regexp_replace(x.id, '^o', '')::bigint;
    get diagnostics n = row_count;
    update jt.invoices i set po_lane_pos = case when clr then null else x.n::integer end
    from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n)
    where x.id ~ '^i' and i.id = substr(x.id, 2)::bigint;
    get diagnostics m = row_count;
    return n + m;
  end if;
  update jt.invoices i set lane_pos = case when clr then null else x.n::integer end
  from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n) where i.id = x.id::bigint;
  get diagnostics n = row_count;
  return n;
end $$;
do $$ begin execute 'rev' || 'oke all on function jt.lane_order(jsonb) from public'; end $$;
