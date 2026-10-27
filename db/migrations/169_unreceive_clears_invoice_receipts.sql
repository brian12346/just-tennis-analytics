-- Moving a PO back to Ordered/Invoiced un-receives it (stock comes back out of Shopify / the prep center), but its
-- invoices kept their receipts: they still showed Closed (fully received) and the PO couldn't be received again
-- (Brian, Oct 27: Babolat order 2879028 — 3,172 units un-received, both invoices still "Closed", 0 received).
-- jt.prep_order_status now also zeroes the order's invoice receipts and clears received_at (except "marked received").
-- Patches the live function in place (so this file stays in step with whatever 161+ defined); runs once.
do $$
declare d text := pg_get_functiondef('jt.prep_order_status(jsonb)'::regprocedure);
        anchor text := E'      update jt.prep_order_lines set qty_received = 0 where order_id = ord;\n';
begin
  if position('migration 169' in d) > 0 then return; end if;
  if position(anchor in d) = 0 then raise exception 'prep_order_status changed; update migration 169'; end if;
  execute replace(d, anchor, anchor ||
    E'      -- the order''s invoices aren''t received any more either (migration 169: they stayed Closed and couldn''t be received again)\n' ||
    E'      update jt.invoice_receipts ir set qty = 0 from jt.invoices i where i.id = ir.invoice_id and i.order_id = ord and ir.qty <> 0;\n' ||
    E'      update jt.invoices set received_at = null where order_id = ord and not received_manual;\n');
end $$;
