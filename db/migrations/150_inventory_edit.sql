-- Edit inventory from the product popup (Brian, Oct 15 — customer feedback: "edit inventory and transfer to/from
-- shopify from this screen … a save button … visual indicators of what has changed … log it as an inventory change").
-- One save applies, in order:
--   1. prep center counts per listing (set to the counted number; logged in jt.prep_moves as 'adjust'),
--   2. a Shopify count (set Shopify's available stock at the store's location to the counted number: the difference
--      from what Seller Sage last saw, pending moves included, goes to jt.shopify_stock_moves),
--   3. transfers between the prep center (a listing's stock) and the Shopify store, either way: the prep center side is
--      logged in jt.prep_moves ('to_shopify' / 'from_shopify'), the Shopify side is a jt.shopify_stock_moves row.
-- Shopify changes are applied by the sync job "fbm-inventory" (started right away; the hourly run catches misses).
-- Everything or nothing: a transfer asking for more than the prep center has fails the whole save.

alter table jt.prep_moves drop constraint if exists prep_moves_kind_check;
alter table jt.prep_moves add constraint prep_moves_kind_check
  check (kind in ('seed', 'adjust', 'ship', 'receive', 'unship', 'unreceive', 'assign', 'reconcile', 'to_shopify', 'from_shopify'));
alter table jt.shopify_stock_moves add column if not exists kind text not null default 'reconcile';   -- reconcile | count | to_shopify | from_shopify
alter table jt.shopify_stock_moves add column if not exists amazon_sku text not null default '';

-- Shopify's available stock as Seller Sage sees it: the last synced quantity plus moves not applied yet
create or replace function jt.shopify_qty_now(vid bigint) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce((select v.inventory_qty from jt.variants v where v.variant_id = vid), 0)
       + coalesce((select sum(m.delta) from jt.shopify_stock_moves m where m.variant_id = vid and m.status = 'pending'), 0)::integer
$$;
grant execute on function jt.shopify_qty_now(bigint) to public;   -- a read helper (the page reads it through jt_sql)

-- p = {variant_id, note, by,
--      prep: [{amazon_sku, qty}]                       counted units per listing ('' = not earmarked),
--      shopify: {qty, expect}                          counted Shopify units; expect = the number the page showed,
--      moves: [{dir: 'to_shopify' | 'from_shopify', amazon_sku, qty}]}
-- Returns {prep, shopify, moved, shopify_now, prep_now: {sku: qty}}.
create or replace function jt.inventory_edit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; who text := coalesce(p->>'by', ''); note text := btrim(coalesce(p->>'note', ''));
        x jsonb; sku text; want integer; cur integer; q integer; d integer; nprep int := 0; nmove int := 0; sdelta integer := 0;
        shop_now integer; dispatch boolean := false; tag text;
begin
  if vid is null or not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', p->>'variant_id'; end if;
  perform 1 from jt.variants v where v.variant_id = vid for update;          -- one save at a time per product
  tag := case when note = '' then 'product screen' else note end;

  -- 1. prep center counts
  for x in select * from jsonb_array_elements(coalesce(p->'prep', '[]'::jsonb)) loop
    sku := coalesce(x->>'amazon_sku', ''); want := (x->>'qty')::integer;
    if want is null or want < 0 then raise exception 'a prep center count must be 0 or more'; end if;
    select i.qty into cur from jt.prep_items i where i.variant_id = vid and i.amazon_sku = sku for update;
    if coalesce(cur, 0) = want then continue; end if;
    insert into jt.prep_items (variant_id, amazon_sku, qty) values (vid, sku, want)
      on conflict (variant_id, amazon_sku) do update set qty = excluded.qty, updated_at = now();
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user)
    values ('adjust', vid, sku, want - coalesce(cur, 0), want, 'count: ' || tag, who);
    nprep := nprep + 1;
  end loop;

  -- 2. Shopify count
  if p ? 'shopify' and p->'shopify'->>'qty' is not null then
    want := (p->'shopify'->>'qty')::integer;
    shop_now := jt.shopify_qty_now(vid);
    if p->'shopify'->>'expect' is not null and (p->'shopify'->>'expect')::integer <> shop_now then
      raise exception 'Shopify on hand changed to % since this screen loaded - reload and count again', shop_now;
    end if;
    if want - shop_now <> 0 then
      insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, created_by)
      values (vid, want - shop_now, 'count ' || shop_now || ' -> ' || want || ', ' || tag, 'count', who);
      sdelta := want - shop_now; dispatch := true;
    end if;
  end if;

  -- 3. transfers
  for x in select * from jsonb_array_elements(coalesce(p->'moves', '[]'::jsonb)) loop
    sku := coalesce(x->>'amazon_sku', ''); q := (x->>'qty')::integer;
    if q is null or q <= 0 then raise exception 'a transfer needs a quantity above 0'; end if;
    if x->>'dir' = 'to_shopify' then
      d := jt.prep_stock_add(vid, sku, -q, 'to_shopify', 'to Shopify store: ' || tag, who, null, '');
      if -d < q then
        raise exception 'only % at the prep center for %, can''t move % to Shopify', -d, case when sku = '' then 'any listing' else sku end, q;
      end if;
      insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, amazon_sku, created_by)
      values (vid, q, 'from prep center' || case when sku = '' then '' else ' (' || sku || ')' end || ', ' || tag, 'to_shopify', sku, who);
    elsif x->>'dir' = 'from_shopify' then
      insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, amazon_sku, created_by)
      values (vid, -q, 'to prep center' || case when sku = '' then '' else ' (' || sku || ')' end || ', ' || tag, 'from_shopify', sku, who);
      perform jt.prep_stock_add(vid, sku, q, 'from_shopify', 'from Shopify store: ' || tag, who, null, '');
    else
      raise exception 'a transfer goes to_shopify or from_shopify';
    end if;
    nmove := nmove + 1; dispatch := true;
  end loop;

  if dispatch then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;   -- hourly sync catches it otherwise
  end if;
  return jsonb_build_object('prep', nprep, 'shopify', sdelta, 'moved', nmove, 'shopify_now', jt.shopify_qty_now(vid),
    'prep_now', coalesce((select jsonb_object_agg(i.amazon_sku, i.qty) from jt.prep_items i where i.variant_id = vid and i.qty > 0), '{}'::jsonb));
end $$;
-- security invoker: only the app's own wrapper below (security definer) and the dashboard's SQL path can write with
-- it; anyone else calling it directly has no rights on the tables it changes
alter function jt.inventory_edit(jsonb) security invoker;

create or replace function public.jt_inventory_edit(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.inventory_edit(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
-- (callable by anyone with the publishable key, but refused unless the signed-in user is an app user)
grant execute on function public.jt_inventory_edit(jsonb) to authenticated;
