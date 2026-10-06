-- Seller Central is the source of truth for what's in a prep center shipment. When a prep shipment is linked to
-- Seller Central shipments (086), its lines become Seller Central's quantities (in Shopify units, by seller SKU), and
-- the difference per product is dispositioned: units Seller Central doesn't have either stay in the prep center
-- (earmarked for an Amazon listing) or go back into Shopify inventory (jt.shopify_stock_moves, applied to Shopify by
-- the sync job "fbm-inventory"). Units Seller Central has beyond the prep shipment come out of the prep center.

alter table jt.prep_moves drop constraint if exists prep_moves_kind_check;
alter table jt.prep_moves add constraint prep_moves_kind_check
  check (kind in ('seed', 'adjust', 'ship', 'receive', 'unship', 'unreceive', 'assign', 'reconcile', 'to_shopify'));

-- Units to add to (delta > 0) or take out of Shopify's available stock at the store's location (jt.settings
-- fbm_sync.location_id), applied by sync/shopify.py apply_stock_moves.
create table if not exists jt.shopify_stock_moves (
  id                bigserial primary key,
  variant_id        bigint not null,
  delta             integer not null check (delta <> 0),
  reason            text not null default '',
  prep_shipment_id  bigint references jt.prep_shipments (id) on delete set null,
  status            text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error             text not null default '',
  shopify_before    integer,
  location_id       text,
  created_at        timestamptz not null default now(),
  created_by        text not null default '',
  applied_at        timestamptz
);
create index if not exists shopify_stock_moves_pending on jt.shopify_stock_moves (status) where status = 'pending';

-- add delta units to the prep center for (variant, listing), logged as a move; never below 0. Returns the units moved.
create or replace function jt.prep_stock_add(vid bigint, sku text, delta integer, k text, note text, who text, sid bigint, sname text)
returns integer language plpgsql security definer set search_path = '' as $$
declare cur integer; d integer := delta; after integer;
begin
  if d = 0 then return 0; end if;
  select qty into cur from jt.prep_items where variant_id = vid and amazon_sku = sku for update;
  if d < 0 then d := -least(-d, coalesce(cur, 0)); if d = 0 then return 0; end if; end if;
  if d < 0 then
    update jt.prep_items set qty = qty + d, updated_at = now() where variant_id = vid and amazon_sku = sku returning qty into after;
  else
    insert into jt.prep_items (variant_id, amazon_sku, qty) values (vid, sku, d)
      on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now()
      returning qty into after;
  end if;
  insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, shipment_id)
  values (k, vid, sku, d, after, sname, note, who, sid);
  return d;
end $$;
revoke all on function jt.prep_stock_add(bigint, text, integer, text, text, text, bigint, text) from public;

-- p = {lines: [{variant_id, amazon_sku, qty}] (Seller Central's contents in Shopify units),
--      dispose: [{variant_id, to: 'prep' | 'shopify', amazon_sku}] (units Seller Central doesn't have, per product)}
-- Returns {lines, to_prep, to_shopify, taken, short} (units).
create or replace function jt.prep_ship_reconcile(sid bigint, p jsonb, who text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; v bigint; o int; n int; sur int; dsp jsonb; tsku text; x record; need int; got int; avail int;
  sname text; to_prep int := 0; to_shop int := 0; taken int := 0; short int := 0; shipped boolean;
begin
  select * into s from jt.prep_shipments where id = sid for update;
  if s.id is null then raise exception 'shipment % not found', sid; end if;
  shipped := s.status = 'shipped';
  sname := coalesce(nullif(s.name, ''), 'Shipment ' || sid);
  create temp table if not exists pg_temp._rec_new (variant_id bigint, amazon_sku text, qty int) on commit drop;
  delete from pg_temp._rec_new;
  insert into pg_temp._rec_new select (l->>'variant_id')::bigint, coalesce(l->>'amazon_sku', ''), sum((l->>'qty')::int)
    from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) l where coalesce((l->>'qty')::int, 0) > 0 group by 1, 2;
  if not exists (select 1 from pg_temp._rec_new) then raise exception 'Seller Central has no products for this shipment'; end if;

  for v in select variant_id from jt.prep_shipment_lines where shipment_id = sid union select variant_id from pg_temp._rec_new loop
    select coalesce(sum(qty), 0) into o from jt.prep_shipment_lines where shipment_id = sid and variant_id = v;
    select coalesce(sum(qty), 0) into n from pg_temp._rec_new where variant_id = v;
    sur := o - n;
    select d into dsp from jsonb_array_elements(coalesce(p->'dispose', '[]'::jsonb)) d where (d->>'variant_id')::bigint = v limit 1;
    tsku := case when dsp ? 'amazon_sku' then coalesce(dsp->>'amazon_sku', '') else coalesce((select amazon_sku from pg_temp._rec_new where variant_id = v order by qty desc limit 1),
                     (select amazon_sku from jt.prep_shipment_lines where shipment_id = sid and variant_id = v order by qty desc limit 1), '') end;
    if not shipped then
      -- earmark what Seller Central expects per listing, from the product's not-earmarked stock
      for x in select * from pg_temp._rec_new where variant_id = v and amazon_sku <> '' loop
        select coalesce((select qty from jt.prep_items where variant_id = v and amazon_sku = x.amazon_sku), 0) into avail;
        if avail < x.qty then
          got := -jt.prep_stock_add(v, '', -(x.qty - avail), 'assign', 'to ' || x.amazon_sku || ' · Seller Central ' || sname, who, sid, sname);
          perform jt.prep_stock_add(v, x.amazon_sku, got, 'assign', 'from any listing · Seller Central ' || sname, who, sid, sname);
        end if;
      end loop;
    end if;
    if sur > 0 then
      if coalesce(dsp->>'to', 'prep') = 'shopify' then
        if not shipped then
          -- not shipped yet: the units are still on the prep center's count; take them out (not-earmarked stock first)
          need := sur;
          for x in select amazon_sku from jt.prep_items where variant_id = v order by (amazon_sku = '') desc,
                     (amazon_sku in (select amazon_sku from jt.prep_shipment_lines where shipment_id = sid and variant_id = v)) desc, qty desc loop
            exit when need <= 0;
            need := need + jt.prep_stock_add(v, x.amazon_sku, -need, 'to_shopify', 'not in Seller Central ' || sname || ' · back to Shopify', who, sid, sname);
          end loop;
          sur := sur - need;
        end if;
        if sur > 0 then
          insert into jt.shopify_stock_moves (variant_id, delta, reason, prep_shipment_id, created_by)
          values (v, sur, 'Not in Seller Central shipment ' || sname, sid, who);
          to_shop := to_shop + sur;
        end if;
      elsif shipped then
        -- shipped: the units were taken out of the prep center; they come back, earmarked for the listing
        to_prep := to_prep + jt.prep_stock_add(v, tsku, sur, 'reconcile', 'not in Seller Central ' || sname, who, sid, sname);
      else
        -- not shipped: they're still counted; earmark them for the listing (from not-earmarked stock)
        if tsku <> '' then
          got := -jt.prep_stock_add(v, '', -sur, 'assign', 'to ' || tsku || ' · not in Seller Central ' || sname, who, sid, sname);
          perform jt.prep_stock_add(v, tsku, got, 'assign', 'from any listing · not in Seller Central ' || sname, who, sid, sname);
        end if;
        to_prep := to_prep + sur;
      end if;
    elsif sur < 0 and shipped then
      -- Seller Central has more than went out: take the rest out of the prep center (its listings, then not earmarked)
      need := -sur;
      for x in select amazon_sku from jt.prep_items where variant_id = v
                 order by (amazon_sku in (select amazon_sku from pg_temp._rec_new where variant_id = v)) desc, (amazon_sku = '') desc, qty desc loop
        exit when need <= 0;
        need := need + jt.prep_stock_add(v, x.amazon_sku, -need, 'reconcile', 'more in Seller Central ' || sname, who, sid, sname);
      end loop;
      taken := taken + (-sur - need); short := short + need;
    end if;
  end loop;

  delete from jt.prep_shipment_lines where shipment_id = sid;
  insert into jt.prep_shipment_lines (shipment_id, variant_id, amazon_sku, qty) select sid, variant_id, amazon_sku, qty from pg_temp._rec_new;
  delete from jt.prep_items where qty = 0;
  update jt.prep_shipments set updated_at = now() where id = sid;
  if to_shop > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;   -- hourly sync catches it otherwise
  end if;
  return jsonb_build_object('lines', (select count(*) from pg_temp._rec_new), 'to_prep', to_prep, 'to_shopify', to_shop, 'taken', taken, 'short', short);
end $$;
revoke all on function jt.prep_ship_reconcile(bigint, jsonb, text) from public;

-- prep_ship_link (086) + reconcile: p.reconcile = {lines, dispose} applies Seller Central's contents after linking.
-- Returns {linked, reconcile} as jsonb.
create or replace function jt.prep_ship_link2(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int := 0; r jsonb := null;
begin
  if jsonb_typeof(p->'amazon_ids') = 'array' and jsonb_array_length(p->'amazon_ids') > 0 or coalesce((p->>'unlink')::boolean, false) then
    n := jt.prep_ship_link(p);
  end if;
  if jsonb_typeof(p->'reconcile') = 'object' then
    r := jt.prep_ship_reconcile((p->>'shipment_id')::bigint, p->'reconcile', coalesce(p->>'by', ''));
  end if;
  return jsonb_build_object('linked', n, 'reconcile', r);
end $$;
revoke all on function jt.prep_ship_link2(jsonb) from public;

create or replace function public.jt_prep_ship_link2(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_ship_link2(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_ship_link2(jsonb) from public, anon;
grant execute on function public.jt_prep_ship_link2(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.shopify_stock_moves to jt_reader; end if;
end $$;
