-- Close a PO "over" (Brian, Oct 29: "when more products are received than are on an invoice, we need to be able to
-- close that out as a vendor mistake. we don't want those cards to accumulate. maybe it's a close PO as over rather
-- than short?"). jt.po_close_over records, per product, the units received that no invoice counts (what the "no
-- invoice yet" card shows) as an overage the vendor won't bill: the card goes away; the units stay in stock. Units
-- received after that, with no invoice, show again. p = {id, undo: true to take it back, note, by}.
alter table jt.prep_orders add column if not exists over_closed jsonb not null default '{}'::jsonb;
alter table jt.prep_orders add column if not exists over_closed_at timestamptz;
alter table jt.prep_orders add column if not exists over_closed_by text not null default '';

create or replace function jt.po_close_over(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; snap jsonb; n integer;
begin
  perform 1 from jt.prep_orders where id = ord for update;
  if not found then raise exception 'order % not found', ord; end if;
  if coalesce((p->>'undo')::boolean, false) then
    update jt.prep_orders set over_closed = '{}'::jsonb, over_closed_at = null, over_closed_by = '', updated_at = now() where id = ord;
    return 0;
  end if;
  select coalesce(jsonb_object_agg(x.variant_id::text, x.gap), '{}'::jsonb), count(*) into snap, n from (
    select l.variant_id, sum(l.qty_received) - coalesce((select sum(ir.qty) from jt.invoice_receipts ir join jt.invoices i on i.id = ir.invoice_id
      where i.order_id = ord and ir.variant_id = l.variant_id), 0) as gap
    from jt.prep_order_lines l where l.order_id = ord and l.dest <> 'demo' group by l.variant_id) x where x.gap > 0;
  if n = 0 then raise exception 'nothing on this order is received without an invoice'; end if;
  update jt.prep_orders set over_closed = snap, over_closed_at = now(), over_closed_by = coalesce(p->>'by', ''),
    note = case when coalesce(p->>'note', '') = '' then note else btrim(note || E'\n' || (p->>'note')) end, updated_at = now()
  where id = ord;
  return n;
end $$;

create or replace function public.jt_po_close_over(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_close_over(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.po_close_over(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_po_close_over(jsonb) from public, anon';
  execute 'grant execute on function public.jt_po_close_over(jsonb) to authenticated';
end $$;
