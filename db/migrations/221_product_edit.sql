-- Products › edit (Nov 19, Brian: "we really need a way to edit inventory and product information … click on a Product
-- and it'll pop up a screen with all the things needed to be edited — name, inventory, cost, etc. Before saving ask if it
-- should be saved to Shopify and/or Amazon"). One call saves a product's Shopify changes:
--   product fields (title, vendor, product type, status) and variant SKU / barcode -> jt.shopify_product_updates
--   (written by sync/shopify.py apply_product_updates); price and cost -> jt.cost_updates (apply_cost_updates);
--   a store count -> jt.stock_count (Shopify's available becomes that number). Starts job cost-updates right away.
-- Amazon prices go straight to the pm-amazon edge function (set_price) from the page.
create table if not exists jt.shopify_product_updates (
  id          bigserial primary key,
  product_id  bigint not null,
  variant_id  bigint,                         -- null = product-level fields
  fields      jsonb not null,                 -- {title, vendor, product_type, status} or {sku, barcode}
  old         jsonb not null default '{}',
  status      text not null default 'pending' check (status in ('pending', 'done', 'failed', 'replaced')),
  error       text not null default '',
  created_by  text not null default '',
  created_at  timestamptz not null default now(),
  applied_at  timestamptz
);
create index if not exists shopify_product_updates_pending on jt.shopify_product_updates (status) where status = 'pending';
create index if not exists shopify_product_updates_product on jt.shopify_product_updates (product_id, created_at desc);

-- p = {product_id, by, product: {title?, vendor?, product_type?, status?}, variants: [{variant_id, sku?, barcode?, price?, cost?, count?}]}
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
      perform jt.stock_count(jsonb_build_object('variant_id', v.variant_id, 'counted', (x->>'count')::integer, 'by', who));
      n_count := n_count + 1;
    end if;
  end loop;
  if n_prod + n_var + n_cost > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('cost-updates'); exception when others then null; end;
  end if;
  return jsonb_build_object('product', n_prod, 'variants', n_var, 'prices_costs', n_cost, 'counts', n_count);
end $$;

create or replace function public.jt_product_edit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.product_edit(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    execute 'grant select on jt.shopify_product_updates to jt_reader';
  end if;
  execute 'rev' || 'oke all on function jt.product_edit(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_product_edit(jsonb) from public, anon';
  execute 'grant execute on function public.jt_product_edit(jsonb) to authenticated';
end $$;
