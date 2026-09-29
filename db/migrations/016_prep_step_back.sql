-- Step back one stage on Amazon Outgoing shipments and Incoming Inventory orders.
--   Outgoing: shipped -> started puts the units back in the prep center (moves kind 'unship'); started -> open as before.
--             If the shipment came from an order that it marked shipped, that order goes back to received.
--   Incoming: shipped -> received (no stock change); received -> an earlier stage takes the received units back out of
--             the prep center (moves kind 'unreceive') — refused if the prep center no longer has them.

alter table jt.prep_moves drop constraint if exists prep_moves_kind_check;
alter table jt.prep_moves add constraint prep_moves_kind_check check (kind in ('seed', 'adjust', 'ship', 'receive', 'unship', 'unreceive'));

create or replace function jt.prep_shipment_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p->>'id')::bigint; want text := p->>'status'; s record; lines jsonb; l record; after integer;
begin
  if want not in ('open', 'started', 'shipped') then raise exception 'unknown status %', want; end if;
  select * into s from jt.prep_shipments where id = sid for update;
  if s.id is null then raise exception 'shipment % not found', sid; end if;
  if s.status = want then return want; end if;
  if s.status = 'shipped' then
    -- un-ship: every line goes back into the prep center
    if want <> 'started' then raise exception 'a shipped shipment goes back to started first'; end if;
    for l in select * from jt.prep_shipment_lines where shipment_id = sid loop
      insert into jt.prep_items (variant_id, amazon_sku, qty) values (l.variant_id, l.amazon_sku, l.qty)
        on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now()
        returning qty into after;
      insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, dest, note, by_user, shipment_id)
      values ('unship', l.variant_id, l.amazon_sku, l.qty, after, coalesce(nullif(s.name, ''), 'Shipment ' || sid), s.dest, 'moved back to started', coalesce(p->>'by', ''), sid);
    end loop;
    update jt.prep_shipments set status = 'started', shipped_at = null, shipped_by = '', updated_at = now() where id = sid;
    if s.order_id is not null then
      update jt.prep_orders set status = 'received', stage_at = stage_at - 'shipped', updated_at = now() where id = s.order_id and status = 'shipped';
    end if;
    return want;
  end if;
  if want = 'shipped' then
    select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'amazon_sku', amazon_sku, 'qty', qty)) into lines
    from jt.prep_shipment_lines where shipment_id = sid;
    if lines is null then raise exception 'shipment % has no products', sid; end if;
    perform jt.prep_ship(jsonb_build_object('shipment', coalesce(nullif(s.name, ''), 'Shipment ' || sid), 'dest', s.dest,
      'note', s.note, 'by', coalesce(p->>'by', ''), 'lines', lines));
    update jt.prep_moves set shipment_id = sid where kind = 'ship' and shipment_id is null and at = now();
    update jt.prep_shipments set status = 'shipped', shipped_at = now(), shipped_by = coalesce(p->>'by', ''),
      started_at = coalesce(started_at, now()), updated_at = now() where id = sid;
    if s.order_id is not null then
      update jt.prep_orders set status = 'shipped', stage_at = stage_at || jsonb_build_object('shipped', now()), updated_at = now()
      where id = s.order_id and status = 'received';
    end if;
  else
    update jt.prep_shipments set status = want, started_at = case when want = 'started' then coalesce(started_at, now()) else started_at end,
      updated_at = now() where id = sid;
  end if;
  return want;
end $$;

create or replace function jt.prep_order_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; want text := p->>'status'; o record; l record; have integer; after integer;
begin
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  if o.status = want then return want; end if;
  if want in ('draft', 'ordered', 'invoice', 'packing_slip') then
    if o.status = 'shipped' then raise exception 'a shipped order goes back to received first'; end if;
    if o.status = 'received' then
      -- un-receive: take what was received back out of the prep center
      for l in select * from jt.prep_order_lines where order_id = ord and qty_received > 0 loop
        select qty into have from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku for update;
        if coalesce(have, 0) < l.qty_received then
          raise exception 'only % of variant % % left in the prep center, % were received on this order — some already went out',
            coalesce(have, 0), l.variant_id, l.amazon_sku, l.qty_received;
        end if;
        update jt.prep_items set qty = qty - l.qty_received, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku
          returning qty into after;
        insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
        values ('unreceive', l.variant_id, l.amazon_sku, -l.qty_received, after, coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
          'moved back to ' || replace(want, '_', ' '), coalesce(p->>'by', ''), ord);
      end loop;
      delete from jt.prep_items where qty = 0;
      delete from jt.prep_order_lines where order_id = ord and qty_ordered = 0;   -- lines that only existed because they were received
      update jt.prep_order_lines set qty_received = 0 where order_id = ord;
      update jt.prep_orders set short_ok = false, stage_at = stage_at - 'received' - 'shipped' where id = ord;
    end if;
  elsif want = 'received' then
    if o.status <> 'shipped' then raise exception 'use receive to take an order in'; end if;
    update jt.prep_orders set status = 'received', stage_at = stage_at - 'shipped', updated_at = now() where id = ord;
    return want;
  elsif want = 'shipped' then
    if o.status <> 'received' then raise exception 'only a received order can be marked shipped'; end if;
  else raise exception 'unknown status %', want; end if;
  update jt.prep_orders set status = want, stage_at = stage_at || jsonb_build_object(want, now()), updated_at = now() where id = ord;
  return want;
end $$;
