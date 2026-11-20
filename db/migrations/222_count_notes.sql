-- Inventory adjustments with a comment (Nov 19, Brian: "a way to add a comment when adjusting inventory — a little paper
-- trail so to speak"). A store count can carry a note: kept on jt.stock_counts.note and in the Shopify move's reason
-- ("physical count: 12 · found 2 behind the counter"), which the item detail's "Changes made in Seller Sage" list shows.
-- Prep center counts and moves already keep a note (jt.prep_moves.note).
alter table jt.stock_counts add column if not exists note text not null default '';

-- p = {variant_id, counted, by, note}
create or replace function jt.stock_count(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; n integer := (p->>'counted')::integer; v record; mid bigint; cid bigint;
        nt text := left(trim(coalesce(p->>'note', '')), 300);
begin
  if n is null or n < 0 then raise exception 'enter a count of 0 or more'; end if;
  select variant_id, inventory_item_id, inventory_qty, display_name into v from jt.variants where variant_id = vid;
  if v.variant_id is null then raise exception 'product % not found', vid; end if;
  if v.inventory_item_id is null then raise exception 'this product has no Shopify inventory item'; end if;
  insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, set_to, created_by)
  values (vid, n - jt.shopify_qty_now(vid), 'physical count: ' || n || case when nt <> '' then ' · ' || nt else '' end, 'count', n, coalesce(p->>'by', ''))
  returning id into mid;
  insert into jt.stock_counts (variant_id, counted, shopify_had, move_id, by, note) values (vid, n, v.inventory_qty, mid, coalesce(p->>'by', ''), nt)
  returning id into cid;
  if to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;
  end if;
  return jsonb_build_object('id', cid, 'move_id', mid);
end $$;

-- Products › edit: a variant's count may carry {note}
create or replace function jt.product_edit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pid bigint := (p->>'product_id')::bigint; who text := coalesce(p->>'by', ''); pf jsonb := '{}'; x jsonb; v record; vf jsonb;
        n_prod integer := 0; n_var integer := 0; n_cost integer := 0; n_count integer := 0; k text;
begin
  if pid is null or not exists (select 1 from jt.variants where product_id = pid) then raise exception 'product % not found', p->>'product_id'; end if;
  -- product-level fields: only the ones given, trimmed; status upper case
  for k in select unnest(array['title', 'vendor', 'product_type', 'status']) loop
    if p->'product' ? k then pf := pf || jsonb_build_object(k, case when k = 'status' then upper(trim(p->'product'->>k)) else trim(p->'product'->>k) end); end if;
  end loop;
  if pf ? 'title' and pf->>'title' = '' then raise exception 'the product needs a name'; end if;
  if pf ? 'status' and pf->>'status' not in ('ACTIVE', 'DRAFT', 'ARCHIVED') then raise exception 'status must be Active, Draft or Archived'; end if;
  if pf <> '{}' then
    update jt.shopify_product_updates u set status = 'replaced' where u.product_id = pid and u.variant_id is null and u.status = 'pending'
      and (select bool_and(pf ? kk) from jsonb_object_keys(u.fields) kk);
    insert into jt.shopify_product_updates (product_id, fields, old, created_by)
    select pid, pf, jsonb_build_object('title', max(product_title), 'vendor', max(vendor), 'product_type', max(product_type), 'status', max(status)), who
    from jt.variants where product_id = pid;
    n_prod := 1;
  end if;
  for x in select * from jsonb_array_elements(coalesce(p->'variants', '[]'::jsonb)) loop
    select * into v from jt.variants where variant_id = (x->>'variant_id')::bigint and product_id = pid;
    if v.variant_id is null then raise exception 'size/color % isn''t part of this product', x->>'variant_id'; end if;
    vf := '{}';
    if x ? 'sku' then vf := vf || jsonb_build_object('sku', trim(x->>'sku')); end if;
    if x ? 'barcode' then vf := vf || jsonb_build_object('barcode', trim(x->>'barcode')); end if;
    if vf <> '{}' then
      update jt.shopify_product_updates u set status = 'replaced' where u.variant_id = v.variant_id and u.status = 'pending'
        and (select bool_and(vf ? kk) from jsonb_object_keys(u.fields) kk);
      insert into jt.shopify_product_updates (product_id, variant_id, fields, old, created_by)
      values (pid, v.variant_id, vf, jsonb_build_object('sku', v.sku, 'barcode', v.barcode), who);
      n_var := n_var + 1;
    end if;
    if (x ? 'price' and x->>'price' <> '') or (x ? 'cost' and x->>'cost' <> '') then
      if nullif(x->>'price', '')::numeric < 0 or nullif(x->>'cost', '')::numeric < 0 then raise exception 'prices and costs must be 0 or more'; end if;
      insert into jt.cost_updates (variant_id, inventory_item_id, old_cost, new_cost, new_price, product_id)
      values (v.variant_id, v.inventory_item_id, v.unit_cost, round(nullif(x->>'cost', '')::numeric, 2), round(nullif(x->>'price', '')::numeric, 2), pid);
      n_cost := n_cost + 1;
    end if;
    if x ? 'count' and x->>'count' <> '' then
      perform jt.stock_count(jsonb_build_object('variant_id', v.variant_id, 'counted', (x->>'count')::integer, 'by', who, 'note', coalesce(x->>'note', '')));
      n_count := n_count + 1;
    end if;
  end loop;
  if n_prod + n_var + n_cost > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('cost-updates'); exception when others then null; end;
  end if;
  return jsonb_build_object('product', n_prod, 'variants', n_var, 'prices_costs', n_cost, 'counts', n_count);
end $$;

