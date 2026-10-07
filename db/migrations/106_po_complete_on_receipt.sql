-- Purchase orders (Brian, Oct 7): no more "Received -> QB ready -> Complete" steps. A PO is complete once it's fully
-- received (or closed short); entering bills in QuickBooks is done per invoice. 'received' and 'qb_ready' are no longer
-- used: a trigger turns them into 'complete', so every receive path ends there. A complete PO can still receive more,
-- un-receive, move back, take invoices and have its lines edited (it used to be locked).

create or replace function jt.prep_orders_complete_when_received() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status in ('received', 'qb_ready') then
    new.status := 'complete';
    new.stage_at := (coalesce(new.stage_at, '{}'::jsonb) - 'qb_ready')
      || case when new.stage_at ? 'complete' then '{}'::jsonb else jsonb_build_object('complete', now()) end;
  end if;
  return new;
end $$;
create or replace trigger prep_orders_complete_when_received before insert or update of status on jt.prep_orders
  for each row execute function jt.prep_orders_complete_when_received();

create or replace function jt.prep_order_receive(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; st text; x jsonb; q integer; vid bigint; sku text; d text; n integer := 0; after integer; ref text; done boolean;
begin
  select status, coalesce(nullif(po_no, ''), vendor || ' order ' || id) into st, ref from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
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

create or replace function jt.prep_order_unreceive_line(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; o record; l record; q integer := coalesce((p->>'qty')::integer, 0); have integer; after integer; tot integer; full_ boolean;
begin
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  select * into l from jt.prep_order_lines where order_id = ord and variant_id = (p->>'variant_id')::bigint
    and amazon_sku = coalesce(p->>'amazon_sku', '') and dest = coalesce(nullif(p->>'dest', ''), 'prep') for update;
  if l.order_id is null then raise exception 'that product isn''t on this order'; end if;
  if q <= 0 then raise exception 'enter how many to un-receive'; end if;
  if q > l.qty_received then raise exception 'only % of this product were received on this order', l.qty_received; end if;
  if l.dest = 'prep' then
    select qty into have from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku for update;
    if coalesce(have, 0) < q then
      raise exception 'only % of this product are left in the prep center; the rest already went out', coalesce(have, 0);
    end if;
    update jt.prep_items set qty = qty - q, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku returning qty into after;
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
    values ('unreceive', l.variant_id, l.amazon_sku, -q, after, coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
            coalesce(nullif(p->>'note', ''), 'un-received on the PO'), coalesce(p->>'by', ''), ord);
    delete from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku and qty = 0;
  end if;
  update jt.prep_order_lines set qty_received = qty_received - q
  where order_id = ord and variant_id = l.variant_id and amazon_sku = l.amazon_sku and dest = l.dest;
  -- take them off the order's invoices too, newest invoice first
  declare left_ numeric := q; r record; t numeric;
  begin
    for r in select ir.invoice_id, ir.qty from jt.invoice_receipts ir join jt.invoices i on i.id = ir.invoice_id
             where i.order_id = ord and ir.variant_id = l.variant_id and ir.qty > 0 order by ir.invoice_id desc loop
      exit when left_ <= 0;
      t := least(left_, r.qty);
      update jt.invoice_receipts set qty = qty - t where invoice_id = r.invoice_id and variant_id = l.variant_id;
      perform jt.invoice_refresh_received(r.invoice_id);
      left_ := left_ - t;
    end loop;
  end;
  select coalesce(sum(qty_received), 0), not exists (select 1 from jt.prep_order_lines where order_id = ord and qty_received < qty_ordered)
    into tot, full_ from jt.prep_order_lines where order_id = ord;
  if o.status in ('partial', 'received', 'qb_ready', 'complete') then
    if tot = 0 then
      update jt.prep_orders set status = case when exists (select 1 from jt.invoices where order_id = ord) then 'invoiced' else 'ordered' end,
        short_ok = false, stage_at = stage_at - 'partial' - 'received' - 'qb_ready' - 'complete', updated_at = now() where id = ord;
    elsif not full_ and not o.short_ok then
      update jt.prep_orders set status = 'partial', stage_at = stage_at - 'received' - 'qb_ready' - 'complete', updated_at = now() where id = ord;
    else
      update jt.prep_orders set updated_at = now() where id = ord;
    end if;
  end if;
  return q;
end $$;

create or replace function jt.invoice_move(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare inv bigint := (p->>'invoice_id')::bigint; ord bigint := (p->>'order_id')::bigint; old bigint; st text;
begin
  select coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1)) into old from jt.invoices i where i.id = inv;
  if not found then raise exception 'invoice % not found', inv; end if;
  select status into st from jt.prep_orders where id = ord;
  if st is null then raise exception 'purchase order % not found', ord; end if;
  if old = ord then return true; end if;
  if exists (select 1 from jt.invoice_receipts where invoice_id = inv and qty > 0) then
    raise exception 'products were already received against this invoice; un-receive them first';
  end if;
  update jt.invoices set order_id = ord, updated_at = now() where id = inv;
  update jt.prep_orders o set invoice_id = (select max(id) from jt.invoices where order_id = o.id), updated_at = now() where o.id in (ord, old);
  return true;
end $$;

create or replace function jt.po_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o jsonb := coalesce(p->'order', '{}'::jsonb) - 'lines' - 'invoice_id'; ord bigint; st text; i jsonb; inv bigint; ist text; ids jsonb := '[]'::jsonb; x jsonb;
begin
  ord := jt.prep_order_save(o || jsonb_build_object('by', coalesce(p->>'by', '')));
  select status into st from jt.prep_orders where id = ord;
  if p ? 'lines' then
    for x in select * from jsonb_array_elements(p->'lines') loop
      if coalesce((x->>'qty')::integer, 0) < 0 then raise exception 'quantities must be 0 or more'; end if;
    end loop;
    with want as (
      select (e->>'variant_id')::bigint as variant_id, coalesce(e->>'amazon_sku', '') as amazon_sku, coalesce(nullif(e->>'dest', ''), 'prep') as dest,
        sum(coalesce((e->>'qty')::integer, 0))::integer as qty, max(nullif(e->>'unit_cost', '')::numeric) as unit_cost,
        bool_or(coalesce((e->>'backorder')::boolean, false)) as backorder, max(nullif(e->>'eta', '')::date) as eta,
        bool_or(coalesce((e->>'update_cost')::boolean, false)) as update_cost
      from jsonb_array_elements(p->'lines') e group by 1, 2, 3
    ), gone as (
      delete from jt.prep_order_lines l where l.order_id = ord and l.qty_received = 0
        and not exists (select 1 from want w where w.variant_id = l.variant_id and w.amazon_sku = l.amazon_sku and w.dest = l.dest)
    )
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost, backorder, eta, update_cost)
    select ord, variant_id, amazon_sku, dest, qty, unit_cost, backorder, eta, update_cost from want
    on conflict (order_id, variant_id, amazon_sku, dest) do update set qty_ordered = excluded.qty_ordered, unit_cost = excluded.unit_cost,
      backorder = excluded.backorder, eta = excluded.eta, update_cost = excluded.update_cost;
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

update jt.prep_orders set status = 'complete', updated_at = updated_at where status in ('received', 'qb_ready');
