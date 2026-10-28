-- PO lines keep the order they're arranged in on the page (Brian, Oct 27: "we also need a way to reorder the items in
-- the PO. it's really nice to be able to group like items together as well as match the invoice line by line").
-- prep_order_lines.pos = the line's place in the list jt.po_save was sent (1 = first); the page reads lines by pos.
-- Lines saved before this have no pos and sort after, in the old order (variant id).
alter table jt.prep_order_lines add column if not exists pos integer;

-- jt.po_save writes pos: patched in place so the rest of the function stays as it is; runs once.
do $$
declare d text := pg_get_functiondef('jt.po_save(jsonb)'::regprocedure);
        a1 text := E'as update_cost\n      from jsonb_array_elements(p->''lines'') e group by 1, 2, 3';
        a2 text := 'insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost, backorder, eta, update_cost)';
        a3 text := 'select ord, variant_id, amazon_sku, dest, qty, unit_cost, backorder, eta, update_cost from want';
        a4 text := 'backorder = excluded.backorder, eta = excluded.eta, update_cost = excluded.update_cost;';
begin
  if position('as pos' in d) > 0 then return; end if;
  if position(a1 in d) = 0 or position(a2 in d) = 0 or position(a3 in d) = 0 or position(a4 in d) = 0 then
    raise exception 'jt.po_save changed; update migration 170';
  end if;
  d := replace(d, a1, E'as update_cost,\n        min(t.n)::integer as pos\n      from jsonb_array_elements(p->''lines'') with ordinality as t(e, n) group by 1, 2, 3');
  d := replace(d, a2, 'insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost, backorder, eta, update_cost, pos)');
  d := replace(d, a3, 'select ord, variant_id, amazon_sku, dest, qty, unit_cost, backorder, eta, update_cost, pos from want');
  d := replace(d, a4, 'backorder = excluded.backorder, eta = excluded.eta, update_cost = excluded.update_cost, pos = excluded.pos;');
  execute d;
end $$;
