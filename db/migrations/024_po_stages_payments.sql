-- Purchase order stages, and paying invoices.
--
-- Stages: draft -> ordered -> invoiced -> partial (some received) -> received -> qb_ready (bills in QuickBooks) -> complete.
-- Receiving sets partial or received by itself (received = every line in full, or the PO closed short). QB ready and
-- complete are set by hand. Stepping back from partial / received to an earlier stage takes the received prep-center
-- units back out (as before). Old stages map: invoice, packing_slip -> invoiced; shipped -> complete; received with
-- lines still to come -> partial. Outgoing Amazon shipments no longer move a PO's stage.
--
-- Invoices get payment details: paid_on (null = unpaid), pay_method (ach, check, credit_card, wire, cash, other),
-- pay_ref (check no. / confirmation / card last 4), paid_from (the bank account or card), paid_amount.

alter table jt.prep_orders drop constraint if exists prep_orders_status_check;
update jt.prep_orders set status = 'invoiced' where status in ('invoice', 'packing_slip');
update jt.prep_orders set status = 'complete' where status = 'shipped';
update jt.prep_orders o set status = 'partial' where status = 'received' and not short_ok
  and exists (select 1 from jt.prep_order_lines l where l.order_id = o.id and l.qty_received < l.qty_ordered);
alter table jt.prep_orders add constraint prep_orders_status_check
  check (status in ('draft', 'ordered', 'invoiced', 'partial', 'received', 'qb_ready', 'complete'));

alter table jt.invoices add column if not exists paid_on date;
alter table jt.invoices add column if not exists pay_method text not null default '';
alter table jt.invoices add column if not exists pay_ref text not null default '';
alter table jt.invoices add column if not exists paid_from text not null default '';
alter table jt.invoices add column if not exists paid_amount numeric(12,2);
alter table jt.invoices drop constraint if exists invoices_pay_method_check;
alter table jt.invoices add constraint invoices_pay_method_check check (pay_method in ('', 'ach', 'check', 'credit_card', 'wire', 'cash', 'other'));

-- p = {paid_on, pay_method, pay_ref, paid_from, paid_amount}; only the keys given change. Works on applied invoices too.
create or replace function jt.invoice_set_payment(inv bigint, p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update jt.invoices set
    paid_on = case when p ? 'paid_on' then nullif(p->>'paid_on', '')::date else paid_on end,
    pay_method = case when p ? 'pay_method' then coalesce(p->>'pay_method', '') else pay_method end,
    pay_ref = case when p ? 'pay_ref' then coalesce(p->>'pay_ref', '') else pay_ref end,
    paid_from = case when p ? 'paid_from' then coalesce(p->>'paid_from', '') else paid_from end,
    paid_amount = case when p ? 'paid_amount' then nullif(p->>'paid_amount', '')::numeric else paid_amount end,
    updated_at = now()
  where id = inv;
end $$;
revoke all on function jt.invoice_set_payment(bigint, jsonb) from public;

create or replace function jt.prep_order_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
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
end $$;

create or replace function jt.prep_order_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select status into st from jt.prep_orders where id = (p->>'id')::bigint for update;
  if st is null then return false; end if;
  if st in ('partial', 'received', 'qb_ready', 'complete') or exists (select 1 from jt.prep_order_lines where order_id = (p->>'id')::bigint and qty_received > 0) then
    raise exception 'a received order can''t be deleted';
  end if;
  delete from jt.prep_orders where id = (p->>'id')::bigint;
  return true;
end $$;

-- Receiving: as before, and the PO becomes partial or received.
create or replace function jt.prep_order_receive(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; st text; x jsonb; q integer; vid bigint; sku text; d text; n integer := 0; after integer; ref text; done boolean;
begin
  select status, coalesce(nullif(po_no, ''), vendor || ' order ' || id) into st, ref from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
  if st in ('qb_ready', 'complete') then raise exception 'this order is %; move it back to received to receive more', replace(st, '_', ' '); end if;
  for x in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    q := coalesce((x->>'qty')::integer, 0); vid := (x->>'variant_id')::bigint; sku := coalesce(x->>'amazon_sku', ''); d := coalesce(nullif(x->>'dest', ''), 'prep');
    if q < 0 then raise exception 'received quantities must be 0 or more'; end if;
    if q = 0 then continue; end if;
    if not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', vid; end if;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, qty_received) values (ord, vid, sku, d, 0, q)
      on conflict (order_id, variant_id, amazon_sku, dest) do update set qty_received = jt.prep_order_lines.qty_received + excluded.qty_received;
    if d = 'prep' then
      insert into jt.prep_items (variant_id, amazon_sku, qty) values (vid, sku, q)
        on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now()
        returning qty into after;
      insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
      values ('receive', vid, sku, q, after, ref, coalesce(p->>'note', ''), coalesce(p->>'by', ''), ord);
    end if;
    n := n + q;
  end loop;
  if n = 0 then raise exception 'nothing to receive'; end if;
  select not exists (select 1 from jt.prep_order_lines l where l.order_id = ord and l.qty_received < l.qty_ordered) or o.short_ok into done
  from jt.prep_orders o where o.id = ord;
  update jt.prep_orders set status = case when done then 'received' else 'partial' end,
    stage_at = stage_at || case when done then jsonb_build_object('received', now()) else '{}'::jsonb end
      || case when stage_at ? 'partial' then '{}'::jsonb else jsonb_build_object('partial', now()) end,
    updated_at = now() where id = ord;
  update jt.prep_list set closed_at = now() where order_id = ord and closed_at is null;
  return n;
end $$;

-- Moving a PO between stages.
create or replace function jt.prep_order_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; want text := p->>'status'; o record; l record; have integer; after integer;
begin
  if want not in ('draft', 'ordered', 'invoiced', 'partial', 'received', 'qb_ready', 'complete') then raise exception 'unknown status %', want; end if;
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  if o.status = want then return want; end if;
  if want in ('draft', 'ordered', 'invoiced') then
    if o.status in ('qb_ready', 'complete') then raise exception 'move it back to received first'; end if;
    if o.status in ('partial', 'received') then
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
    elsif o.status not in ('qb_ready', 'complete') then raise exception 'receive the products first';
    end if;
    update jt.prep_orders set status = 'received', stage_at = (stage_at - 'qb_ready' - 'complete') || case when o.status = 'partial' then jsonb_build_object('received', now()) else '{}'::jsonb end,
      updated_at = now() where id = ord;
    return want;
  elsif want = 'qb_ready' then
    if o.status not in ('received', 'complete') then raise exception 'a PO is QB ready once it''s received'; end if;
    if o.status = 'complete' then update jt.prep_orders set status = want, stage_at = stage_at - 'complete', updated_at = now() where id = ord; return want; end if;
  elsif want = 'complete' then
    if o.status <> 'qb_ready' then raise exception 'mark it QB ready first'; end if;
  end if;
  update jt.prep_orders set status = want, stage_at = stage_at || jsonb_build_object(want, now()), updated_at = now() where id = ord;
  return want;
end $$;

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
  else
    update jt.prep_shipments set status = want, started_at = case when want = 'started' then coalesce(started_at, now()) else started_at end,
      updated_at = now() where id = sid;
  end if;
  return want;
end $$;

-- PO save: lines can change until complete; each invoice's payment details are saved too (also on applied invoices).
create or replace function jt.po_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o jsonb := coalesce(p->'order', '{}'::jsonb) - 'lines' - 'invoice_id'; ord bigint; st text; i jsonb; inv bigint; ist text; ids jsonb := '[]'::jsonb; x jsonb;
begin
  ord := jt.prep_order_save(o || jsonb_build_object('by', coalesce(p->>'by', '')));
  select status into st from jt.prep_orders where id = ord;
  if p ? 'lines' and st <> 'complete' then
    for x in select * from jsonb_array_elements(p->'lines') loop
      if coalesce((x->>'qty')::integer, 0) < 0 then raise exception 'quantities must be 0 or more'; end if;
    end loop;
    with want as (
      select (e->>'variant_id')::bigint as variant_id, coalesce(e->>'amazon_sku', '') as amazon_sku, coalesce(nullif(e->>'dest', ''), 'prep') as dest,
        sum(coalesce((e->>'qty')::integer, 0))::integer as qty, max(nullif(e->>'unit_cost', '')::numeric) as unit_cost,
        bool_or(coalesce((e->>'backorder')::boolean, false)) as backorder, max(nullif(e->>'eta', '')::date) as eta
      from jsonb_array_elements(p->'lines') e group by 1, 2, 3
    ), gone as (
      delete from jt.prep_order_lines l where l.order_id = ord and l.qty_received = 0
        and not exists (select 1 from want w where w.variant_id = l.variant_id and w.amazon_sku = l.amazon_sku and w.dest = l.dest)
    )
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost, backorder, eta)
    select ord, variant_id, amazon_sku, dest, qty, unit_cost, backorder, eta from want
    on conflict (order_id, variant_id, amazon_sku, dest) do update set qty_ordered = excluded.qty_ordered, unit_cost = excluded.unit_cost,
      backorder = excluded.backorder, eta = excluded.eta;
    update jt.prep_list li set order_id = null where li.order_id = ord and li.closed_at is null and not exists (
      select 1 from jt.prep_order_lines l where l.order_id = ord and l.variant_id = li.variant_id and l.amazon_sku = li.amazon_sku and l.dest = li.dest);
  end if;
  -- invoices taken off the order: a draft is deleted, an applied one is only detached
  delete from jt.invoices where order_id = ord and status = 'draft' and id in (select (y #>> '{}')::bigint from jsonb_array_elements(coalesce(p->'remove_invoices', '[]'::jsonb)) y);
  update jt.invoices set order_id = null where order_id = ord and id in (select (y #>> '{}')::bigint from jsonb_array_elements(coalesce(p->'remove_invoices', '[]'::jsonb)) y);
  for i in select * from jsonb_array_elements(coalesce(p->'invoices', '[]'::jsonb)) loop
    inv := nullif(i->>'id', '')::bigint; ist := null;
    if inv is not null then select status into ist from jt.invoices where id = inv; end if;
    if inv is null or ist is distinct from 'applied' then
      inv := jt.save_invoice(i || jsonb_build_object('po_no', coalesce(o->>'po_no', i->>'po_no', '')));
    end if;
    update jt.invoices set order_id = ord where id = inv;
    perform jt.invoice_set_payment(inv, i - 'id' - 'lines');
    ids := ids || to_jsonb(inv);
  end loop;
  update jt.prep_orders set invoice_id = (select max(id) from jt.invoices where order_id = ord) where id = ord;
  perform jt.remember_vendor_items(jsonb_build_object('vendor', (select vendor from jt.prep_orders where id = ord), 'items', coalesce(p->'remember', '[]'::jsonb)));
  return jsonb_build_object('order_id', ord, 'invoice_ids', ids);
end $$;
