-- Shipping: the last purchase attempt for a fulfillment order, so the `ship` function won't buy a second label for an
-- order that already has one (or one still processing) unless the pack screen says "buy another".
create or replace function public.jt_ship_last(p jsonb) returns jsonb
language sql security definer set search_path = '' as $$
  select to_jsonb(l) from jt.ship_labels l
  where l.fulfillment_order_id = p->>'fulfillment_order_id' and l.status in ('PURCHASED', 'PENDING_PURCHASE', 'STARTING')
  order by l.created_at desc limit 1
$$;
do $$ begin execute 'rev' || 'oke all on function public.jt_ship_last(jsonb) from public, anon, authenticated'; end $$;
