-- Hiding a product from the prep center's Incoming products list (e.g. backordered for a long time). The PO line
-- keeps its quantities; incoming_hidden_qty records how many had been received when it was hidden, and the product
-- shows again if more arrive. null = not hidden.

alter table jt.prep_order_lines add column if not exists incoming_hidden_qty integer;

-- p = {order_id, variant_id, amazon_sku, dest, hide: true|false}
create or replace function jt.prep_incoming_hide(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update jt.prep_order_lines set incoming_hidden_qty = case when coalesce((p->>'hide')::boolean, true) then qty_received else null end
  where order_id = (p->>'order_id')::bigint and variant_id = (p->>'variant_id')::bigint
    and amazon_sku = coalesce(p->>'amazon_sku', '') and dest = coalesce(nullif(p->>'dest', ''), 'prep');
  if not found then raise exception 'that product isn''t on order %', p->>'order_id'; end if;
  return true;
end $$;
revoke all on function jt.prep_incoming_hide(jsonb) from public;

create or replace function public.jt_prep_incoming_hide(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_incoming_hide(p);
end $$;
revoke all on function public.jt_prep_incoming_hide(jsonb) from public, anon;
grant execute on function public.jt_prep_incoming_hide(jsonb) to authenticated;
