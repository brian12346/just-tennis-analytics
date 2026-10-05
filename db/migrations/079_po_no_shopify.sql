-- "Seller Sage only" purchase orders: no Shopify PO for this order (set on the PO page). A PO with nothing going to the
-- Shopify store counts as Seller Sage only without it. The page then stops asking for a Shopify link or check.
alter table jt.prep_orders add column if not exists no_shopify_po boolean not null default false;

CREATE OR REPLACE FUNCTION jt.prep_order_save(p jsonb)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ord bigint := nullif(p->>'id', '')::bigint; st text;
begin
  if ord is null then
    insert into jt.prep_orders (vendor, po_no, created_by, stage_at) values (coalesce(p->>'vendor', ''), coalesce(p->>'po_no', ''), coalesce(p->>'by', ''),
      jsonb_build_object('draft', now())) returning id into ord;
    st := 'draft';
  else
    select status into st from jt.prep_orders where id = ord for update;
    if st is null then raise exception 'order % not found', ord; end if;
  end if;
  update jt.prep_orders set
    vendor = case when st in ('partial', 'received', 'qb_ready', 'complete') then vendor else coalesce(p->>'vendor', vendor) end,
    po_no = coalesce(p->>'po_no', po_no),
    invoice_id = case when p ? 'invoice_id' then nullif(p->>'invoice_id', '')::bigint else invoice_id end,
    expected_on = case when p ? 'expected_on' then nullif(p->>'expected_on', '')::date else expected_on end,
    kind = coalesce(nullif(p->>'kind', ''), kind),
    place_by = case when p ? 'place_by' then nullif(p->>'place_by', '')::date else place_by end,
    note = coalesce(p->>'note', note),
    shopify_po_url = coalesce(p->>'shopify_po_url', shopify_po_url),
    no_shopify_po = coalesce((p->>'no_shopify_po')::boolean, no_shopify_po),
    receive_into = case when p->>'receive_into' in ('shopify', 'prep', 'both') then p->>'receive_into' else receive_into end,
    shopify_check = case when not p ? 'shopify_check' then shopify_check when jsonb_typeof(p->'shopify_check') = 'object' then p->'shopify_check' else null end,
    short_ok = coalesce((p->>'short_ok')::boolean, short_ok),
    updated_at = now()
  where id = ord;
  if p ? 'lines' and st not in ('partial', 'received', 'qb_ready', 'complete') then
    delete from jt.prep_order_lines where order_id = ord;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost)
    select ord, (x->>'variant_id')::bigint, coalesce(x->>'amazon_sku', ''), coalesce(nullif(x->>'dest', ''), 'prep'),
      sum(coalesce((x->>'qty')::integer, 0)), max(nullif(x->>'unit_cost', '')::numeric)
    from jsonb_array_elements(p->'lines') x where coalesce((x->>'qty')::integer, 0) >= 0
    group by 2, 3, 4;
    update jt.prep_list i set order_id = null where i.order_id = ord and i.closed_at is null and not exists (
      select 1 from jt.prep_order_lines l where l.order_id = ord and l.variant_id = i.variant_id and l.amazon_sku = i.amazon_sku and l.dest = i.dest);
  end if;
  return ord;
end $function$;
