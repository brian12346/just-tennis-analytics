-- Close as over: units billed on one of the order's invoices aren't an overage, even when the receipt wasn't put
-- against that invoice (Oct 29, PO 21: "it wants me to close as over, but i can't tell what is over"). The gap per
-- product is now received - greatest(received against invoices, billed on invoices); matches the PO page's Short / over.
create or replace function jt.po_close_over(p jsonb)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare ord bigint := (p->>'id')::bigint; snap jsonb; n integer;
begin
  perform 1 from jt.prep_orders where id = ord for update;
  if not found then raise exception 'order % not found', ord; end if;
  if coalesce((p->>'undo')::boolean, false) then
    update jt.prep_orders set over_closed = '{}'::jsonb, over_closed_at = null, over_closed_by = '', updated_at = now() where id = ord;
    return 0;
  end if;
  select coalesce(jsonb_object_agg(x.variant_id::text, x.gap), '{}'::jsonb), count(*) into snap, n from (
    select l.variant_id, sum(l.qty_received) - greatest(
      coalesce((select sum(ir.qty) from jt.invoice_receipts ir join jt.invoices i on i.id = ir.invoice_id
        where i.order_id = ord and ir.variant_id = l.variant_id), 0),
      coalesce((select sum(il.qty) from jt.invoice_lines il join jt.invoices i on i.id = il.invoice_id
        where i.order_id = ord and il.variant_id = l.variant_id and il.match_how <> 'skip'), 0)) as gap
    from jt.prep_order_lines l where l.order_id = ord and l.dest <> 'demo' group by l.variant_id) x where x.gap > 0;
  if n = 0 then raise exception 'nothing on this order is received without an invoice'; end if;
  update jt.prep_orders set over_closed = snap, over_closed_at = now(), over_closed_by = coalesce(p->>'by', ''),
    note = case when coalesce(p->>'note', '') = '' then note else btrim(note || E'\n' || (p->>'note')) end, updated_at = now()
  where id = ord;
  return n;
end $function$;
