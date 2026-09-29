-- A purchase order can have several invoices (a vendor ships and bills in parts). Invoices point at their order
-- (jt.invoices.order_id); prep_orders.invoice_id stays as the order's latest invoice for the Prep center's view.
-- The PO's own lines are what was ordered; each line can be marked backordered with an expected arrival (eta).
-- A line's progress is worked out from the PO: ordered, invoiced (the order's invoice lines for that product),
-- received — anything ordered and not invoiced is "on order" or "backordered".

alter table jt.invoices add column if not exists order_id bigint references jt.prep_orders (id) on delete set null;
create index if not exists invoices_order_idx on jt.invoices (order_id);
update jt.invoices i set order_id = o.id from jt.prep_orders o where o.invoice_id = i.id and i.order_id is null;

alter table jt.prep_order_lines add column if not exists backorder boolean not null default false;
alter table jt.prep_order_lines add column if not exists eta date;          -- expected arrival (null = unknown)

-- Save a purchase order with its invoices.
-- p = {order: {id, vendor, po_no, kind, place_by, expected_on, note, short_ok},
--      lines: [{variant_id, amazon_sku, dest, qty, unit_cost, backorder, eta}],
--      invoices: [{...jt.save_invoice body}], remove_invoices: [ids], remember: [{item_code, variant_id}], by}
-- Lines: any status but shipped. A line already received can't be taken off (it stays). Invoices already applied
-- on the Invoices tab keep their lines. Returns {order_id, invoice_ids: [...] in the order given}.
create or replace function jt.po_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o jsonb := coalesce(p->'order', '{}'::jsonb) - 'lines' - 'invoice_id'; ord bigint; st text; i jsonb; inv bigint; ist text; ids jsonb := '[]'::jsonb; x jsonb;
begin
  ord := jt.prep_order_save(o || jsonb_build_object('by', coalesce(p->>'by', '')));
  select status into st from jt.prep_orders where id = ord;
  if p ? 'lines' and st <> 'shipped' then
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
    ids := ids || to_jsonb(inv);
  end loop;
  update jt.prep_orders set invoice_id = (select max(id) from jt.invoices where order_id = ord) where id = ord;
  perform jt.remember_vendor_items(jsonb_build_object('vendor', (select vendor from jt.prep_orders where id = ord), 'items', coalesce(p->'remember', '[]'::jsonb)));
  return jsonb_build_object('order_id', ord, 'invoice_ids', ids);
end $$;

-- Deleting a draft order takes its draft invoices with it.
create or replace function jt.po_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; invs bigint[];
begin
  select array_agg(id) into invs from jt.invoices where order_id = ord or id = (select invoice_id from jt.prep_orders where id = ord);
  if not jt.prep_order_delete(jsonb_build_object('id', ord)) then return false; end if;
  delete from jt.invoices i where i.id = any(coalesce(invs, '{}')) and i.status = 'draft'
    and not exists (select 1 from jt.prep_orders o where o.invoice_id = i.id);
  return true;
end $$;
