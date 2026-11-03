-- Inventory › Out of stock (Nov 3, Brian): "show all products that have inventory drop to 0 in the last 7 days - either
-- by an order or by an inventory adjustment. each item should have a 'count' button that will prompt the user to enter
-- a new count which will update the inventory. if still 0 it'll stay on the out of stock list, but have a timestamp as
-- to the last physical count".
--   jt.stockouts     the days a Shopify product went to 0 (ShopifyQL inventory: started the day above 0, ended it at 0
--                    or below), with the units sold that day — sold = start means orders, 0 means an adjustment.
--                    Hourly sync (sync_stockouts), last 8 days.
--   jt.stock_counts  every physical count from the page: what was counted, what Shopify had, who, when.
--   A count goes to Shopify as a jt.shopify_stock_moves row with set_to (the counted quantity; the job sets Shopify's
--   available to it, reason cycle_count_available) and starts job fbm-inventory right away.
create table if not exists jt.stockouts (
  variant_id   bigint not null,
  day          date not null,
  start_units  integer not null default 0,
  end_units    integer not null default 0,
  sold         integer not null default 0,
  seen_at      timestamptz not null default now(),
  primary key (variant_id, day)
);

create table if not exists jt.stock_counts (
  id          bigserial primary key,
  variant_id  bigint not null,
  counted     integer not null check (counted >= 0),
  shopify_had integer,
  move_id     bigint,
  by          text not null default '',
  at          timestamptz not null default now()
);
create index if not exists stock_counts_variant on jt.stock_counts (variant_id, at desc);

alter table jt.shopify_stock_moves add column if not exists set_to integer;
-- a count can find Shopify already right (nothing to change), so its delta may be 0; the job records the real change
alter table jt.shopify_stock_moves drop constraint if exists shopify_stock_moves_delta_check;
alter table jt.shopify_stock_moves add constraint shopify_stock_moves_delta_check check (delta <> 0 or set_to is not null);

-- p = {variant_id, counted, by}
create or replace function jt.stock_count(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; n integer := (p->>'counted')::integer; v record; mid bigint; cid bigint;
begin
  if n is null or n < 0 then raise exception 'enter a count of 0 or more'; end if;
  select variant_id, inventory_item_id, inventory_qty, display_name into v from jt.variants where variant_id = vid;
  if v.variant_id is null then raise exception 'product % not found', vid; end if;
  if v.inventory_item_id is null then raise exception 'this product has no Shopify inventory item'; end if;
  insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, set_to, created_by)
  values (vid, n - jt.shopify_qty_now(vid), 'physical count: ' || n, 'count', n, coalesce(p->>'by', ''))
  returning id into mid;
  insert into jt.stock_counts (variant_id, counted, shopify_had, move_id, by) values (vid, n, v.inventory_qty, mid, coalesce(p->>'by', ''))
  returning id into cid;
  if to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;
  end if;
  return jsonb_build_object('id', cid, 'move_id', mid);
end $$;

create or replace function public.jt_stock_count(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.stock_count(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

do $$ begin
  execute 'grant select on jt.stockouts, jt.stock_counts to jt_reader';
  execute 'rev' || 'oke all on function jt.stock_count(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_stock_count(jsonb) from public, anon';
  execute 'grant execute on function public.jt_stock_count(jsonb) to authenticated';
end $$;
