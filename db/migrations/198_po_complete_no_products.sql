-- A purchase order with no products can be marked complete (Nov 3, Brian: "Invoices that we don't want to receive
-- into inventory - we should be able to create a PO and mark it as complete without requiring any products").
-- jt.prep_order_status: 'received'/'complete' from any stage when the order has no product lines (nothing ordered,
-- nothing received). Orders with products still need receiving or Close short, as before.
create or replace function jt.prep_order_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; want text := p->>'status'; o record; l record; have integer; after integer;
begin
  if want not in ('draft', 'ordered', 'invoiced', 'partial', 'received', 'qb_ready', 'complete') then raise exception 'unknown status %', want; end if;
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  if want in ('qb_ready', 'complete') then want := 'received'; end if;          -- QuickBooks is done on the invoice; fully received = complete
  if o.status = want or (want = 'received' and o.status in ('qb_ready', 'complete')) then return o.status; end if;
  if want in ('draft', 'ordered', 'invoiced') then
    if o.status in ('partial', 'received', 'qb_ready', 'complete') then
      -- un-receive: the prep-center units come back out; list items reopen
      for l in select * from jt.prep_order_lines where order_id = ord and qty_received > 0 and dest = 'prep' loop
        select qty into have from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku for update;
        if coalesce(have, 0) < l.qty_received then
          raise exception 'only % of variant % % left in the prep center, % were received on this order — some already went out',
            coalesce(have, 0), l.variant_id, l.amazon_sku, l.qty_received;
        end if;
        update jt.prep_items set qty = qty - l.qty_received, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku
          returning qty into after;
        insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
        values ('unreceive', l.variant_id, l.amazon_sku, -l.qty_received, after, coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
          'moved back to ' || want, coalesce(p->>'by', ''), ord);
      end loop;
      delete from jt.prep_items where qty = 0;
      for l in select * from jt.prep_order_lines where order_id = ord and dest = 'shopify' and qty_pushed > 0 loop
        insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, amazon_sku, order_id, created_by)
        values (l.variant_id, -l.qty_pushed, 'un-received on ' || coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord), 'unreceive', l.amazon_sku, ord, coalesce(p->>'by', ''));
      end loop;
      if found and to_regprocedure('jt.dispatch_sync(text)') is not null then
        begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;
      end if;
      update jt.prep_order_lines set qty_pushed = 0 where order_id = ord;
      delete from jt.prep_order_lines where order_id = ord and qty_ordered = 0 and not exists (
        select 1 from jt.prep_list i where i.order_id = ord and i.variant_id = jt.prep_order_lines.variant_id and i.amazon_sku = jt.prep_order_lines.amazon_sku and i.dest = jt.prep_order_lines.dest);
      update jt.prep_order_lines set qty_received = 0 where order_id = ord;
      update jt.prep_orders set short_ok = false, stage_at = stage_at - 'partial' - 'received' - 'qb_ready' - 'complete' where id = ord;
      update jt.prep_list i set closed_at = null where i.order_id = ord and i.closed_at is not null
        and not exists (select 1 from jt.prep_list j where j.variant_id = i.variant_id and j.amazon_sku = i.amazon_sku and j.dest = i.dest and j.closed_at is null);
    end if;
  elsif want = 'partial' then
    raise exception 'receive the products to make it partly received';
  elsif want = 'received' then
    if o.status = 'partial' then update jt.prep_orders set short_ok = true where id = ord;          -- closed short: the rest isn't coming
    elsif o.status not in ('qb_ready', 'complete') then
      -- nothing to receive (Nov 3, Brian): a PO for an invoice that doesn't go into inventory has no products
      if exists (select 1 from jt.prep_order_lines where order_id = ord and (qty_ordered > 0 or qty_received > 0)) then
        raise exception 'receive the products first';
      end if;
      update jt.prep_orders set status = 'received', stage_at = stage_at || jsonb_build_object('received', now()), updated_at = now() where id = ord;
      return 'received';
    end if;
    update jt.prep_orders set status = 'received', stage_at = stage_at || case when o.status = 'partial' then jsonb_build_object('received', now()) else '{}'::jsonb end,
      updated_at = now() where id = ord;
    return (select status from jt.prep_orders where id = ord);
  elsif want = 'qb_ready' then
    if o.status not in ('received', 'complete') then raise exception 'a PO is QB ready once it''s received'; end if;
    if o.status = 'complete' then update jt.prep_orders set status = want, stage_at = stage_at - 'complete', updated_at = now() where id = ord; return want; end if;
  elsif want = 'complete' then
    if o.status <> 'qb_ready' then raise exception 'mark it QB ready first'; end if;
  end if;
  update jt.prep_orders set status = want, stage_at = stage_at || jsonb_build_object(want, now()), updated_at = now() where id = ord;
  return (select status from jt.prep_orders where id = ord);
end $$;

