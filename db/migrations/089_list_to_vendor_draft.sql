-- On The List builds one draft PO per vendor: a product added to the list (the Prep center's "+ List" and search,
-- Amazon inventory, Inventory value) goes straight onto its vendor's draft purchase order — the newest draft
-- (kind 'order') for that vendor, or a new one. Items already on the list without an order are put on their
-- vendor's draft too.

-- the vendor's draft PO (newest), created when there isn't one
create or replace function jt.vendor_draft_order(p_vendor text, p_by text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare ord bigint;
begin
  select id into ord from jt.prep_orders
  where status = 'draft' and kind = 'order' and lower(vendor) = lower(coalesce(p_vendor, ''))
  order by updated_at desc, id desc limit 1;
  if ord is null then
    insert into jt.prep_orders (vendor, po_no, kind, created_by, stage_at)
    values (coalesce(p_vendor, ''), '', 'order', coalesce(p_by, ''), jsonb_build_object('draft', now())) returning id into ord;
  end if;
  return ord;
end $$;
revoke all on function jt.vendor_draft_order(text, text) from public;

create or replace function jt.prep_list_add(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare lid bigint; vid bigint := (p->>'variant_id')::bigint; sku text := coalesce(p->>'amazon_sku', ''); d text := coalesce(nullif(p->>'dest', ''), 'prep');
  oid bigint; ven text;
begin
  if not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', vid; end if;
  select id into lid from jt.prep_list where variant_id = vid and amazon_sku = sku and dest = d and closed_at is null for update;
  if lid is null then
    insert into jt.prep_list (variant_id, amazon_sku, dest, qty, note, source, added_by)
    values (vid, sku, d, nullif(p->>'qty', '')::integer, coalesce(p->>'note', ''), coalesce(p->>'source', ''), coalesce(p->>'by', '')) returning id into lid;
  else
    update jt.prep_list set qty = case when p ? 'qty' then nullif(p->>'qty', '')::integer else qty end, note = coalesce(p->>'note', note) where id = lid;
    -- keep a draft order's line in step with the list quantity
    update jt.prep_order_lines l set qty_ordered = coalesce(i.qty, l.qty_ordered)
    from jt.prep_list i join jt.prep_orders o on o.id = i.order_id
    where i.id = lid and o.status = 'draft' and l.order_id = o.id and l.variant_id = i.variant_id and l.amazon_sku = i.amazon_sku and l.dest = i.dest;
  end if;
  -- onto the vendor's draft PO
  select order_id into oid from jt.prep_list where id = lid;
  if oid is null then
    select coalesce(vendor, '') into ven from jt.variants where variant_id = vid;
    perform jt.prep_list_assign(jsonb_build_object('ids', jsonb_build_array(lid), 'order_id', jt.vendor_draft_order(ven, p->>'by'), 'by', coalesce(p->>'by', '')));
  end if;
  return lid;
end $$;
revoke all on function jt.prep_list_add(jsonb) from public;

-- open list items that aren't on an order yet -> their vendor's draft
do $$ declare r record; begin
  for r in select coalesce(v.vendor, '') as vendor, jsonb_agg(i.id) as ids
           from jt.prep_list i left join jt.variants v on v.variant_id = i.variant_id
           where i.closed_at is null and i.order_id is null group by 1 loop
    perform jt.prep_list_assign(jsonb_build_object('ids', r.ids, 'order_id', jt.vendor_draft_order(r.vendor, 'On The List'), 'by', 'On The List'));
  end loop;
end $$;
