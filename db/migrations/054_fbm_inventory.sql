-- Amazon FBM -> Shopify stock. Amazon FBM orders ship from the Shopify store's stock, so each shipped FBM order
-- should come out of Shopify's inventory. For now every order is confirmed by hand on the dashboard's FBM tab:
-- "Take out of Shopify" queues the units here (status pending) and starts the sync job, which adjusts Shopify's
-- available quantity (sync/shopify.py apply_fbm_adjustments); "Don't take out" records a skip.
--
-- One row per Amazon order + seller SKU. Units = Amazon quantity x the mapping's units (a 3-pack listing mapped to
-- a single Shopify variant with units 3 takes 3).

create table if not exists jt.fbm_decisions (
  order_id          text not null,
  sku               text not null,
  decision          text not null check (decision in ('decrement', 'skip')),
  variant_id        bigint,
  inventory_item_id bigint,
  units             integer not null default 0,
  status            text not null default 'pending',   -- pending | done | failed | skipped
  error             text not null default '',
  decided_by        text not null default '',
  decided_at        timestamptz not null default now(),
  applied_at        timestamptz,
  shopify_before    integer,                           -- Shopify available at the location just before the change
  primary key (order_id, sku)
);
create index if not exists fbm_decisions_pending on jt.fbm_decisions (status) where status = 'pending';

-- start: first purchase day (Pacific) shown; location_id: the Shopify location to take stock from (null = the
-- store's only active location, found by the sync job and saved here).
insert into jt.settings (key, value) values ('fbm_sync', jsonb_build_object('start', '2026-09-25', 'location_id', null))
on conflict (key) do nothing;

-- Every FBM order line since the start day, with its Shopify variant (from the Amazon mapping) and what was decided.
create or replace view jt.v_fbm_lines as
with cfg as (select coalesce((select value from jt.settings where key = 'fbm_sync'), '{}'::jsonb) as v),
maps as materialized (
  select data->>'sku' as sku, data->>'kind' as kind,
         nullif(regexp_replace(coalesce(data->>'variantId', ''), '^.*/', ''), '')::bigint as variant_id,
         greatest(coalesce(nullif(data->>'units', '')::numeric, 1), 1) as map_units
  from jt.docs where collection = 'amzmap'
)
select l.order_id, l.sku, l.asin, l.product_name, l.quantity, l.order_status, l.item_status, l.marketplace,
       l.purchase_at, (l.purchase_at at time zone 'America/Los_Angeles')::date as day,
       l.order_status like 'Shipped%' as shipped,
       l.order_status = 'Cancelled' or l.item_status = 'Cancelled' as cancelled,
       m.kind as map_kind, m.variant_id, m.map_units,
       case when m.kind = 'shopify' and m.variant_id is not null then (l.quantity * m.map_units)::int end as units,
       v.display_name as shopify_title, v.sku as shopify_sku, v.inventory_qty as shopify_qty, v.inventory_item_id,
       v.product_id, v.tracked,
       d.decision, d.status, d.error, d.decided_by, d.decided_at, d.applied_at, d.shopify_before, d.units as decided_units
from jt.amazon_order_lines l
cross join cfg
left join maps m on m.sku = l.sku
left join jt.variants v on v.variant_id = m.variant_id
left join jt.fbm_decisions d on d.order_id = l.order_id and d.sku = l.sku
where l.fulfillment = 'Merchant'
  and l.marketplace in ('us', 'ca', 'mx')
  and (l.purchase_at at time zone 'America/Los_Angeles')::date >= coalesce((cfg.v->>'start')::date, current_date - 7);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.fbm_decisions, jt.v_fbm_lines to jt_reader;
  end if;
end $$;

-- p = {decisions: [{order_id, sku, decision: 'decrement' | 'skip' | 'undo'}], by}
-- 'decrement' needs a shipped, not cancelled line mapped to a Shopify variant; it queues the units (status pending).
-- 'skip' records that the order shouldn't come out of Shopify. 'undo' turns a skip, or a failed decrement, back into
-- undecided (status 'undone' — kept for the record). A decrement already sent to Shopify can't be changed here.
-- Returns {queued, skipped, undone, refused: [{order_id, sku, why}]}.
create or replace function jt.fbm_decide(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  x jsonb; l record; d record; q int := 0; s int := 0; u int := 0; refused jsonb := '[]'::jsonb; why text;
  who text := coalesce(nullif(p->>'by', ''), 'dashboard');
begin
  for x in select * from jsonb_array_elements(coalesce(p->'decisions', '[]'::jsonb)) loop
    select * into l from jt.v_fbm_lines where order_id = x->>'order_id' and sku = x->>'sku';
    select * into d from jt.fbm_decisions where order_id = x->>'order_id' and sku = x->>'sku';
    why := null;
    if l.order_id is null then why := 'not an FBM order line on this page';
    elsif d.status in ('pending', 'done') and d.decision = 'decrement' then why := 'already sent to Shopify';
    elsif x->>'decision' = 'decrement' then
      if l.cancelled then why := 'the order is cancelled';
      elsif not l.shipped then why := 'not shipped yet';
      elsif l.units is null then why := 'the Amazon listing isn''t mapped to a Shopify product';
      elsif l.inventory_item_id is null then why := 'the Shopify product has no inventory item (it appears after the nightly catalog sync)';
      end if;
    elsif x->>'decision' not in ('skip', 'undo') then why := 'unknown decision';
    end if;
    if why is not null then
      refused := refused || jsonb_build_object('order_id', x->>'order_id', 'sku', x->>'sku', 'why', why);
      continue;
    end if;
    if x->>'decision' = 'decrement' then
      insert into jt.fbm_decisions (order_id, sku, decision, variant_id, inventory_item_id, units, status, error, decided_by, decided_at, applied_at, shopify_before)
      values (l.order_id, l.sku, 'decrement', l.variant_id, l.inventory_item_id, l.units, 'pending', '', who, now(), null, null)
      on conflict (order_id, sku) do update set decision = 'decrement', variant_id = excluded.variant_id,
        inventory_item_id = excluded.inventory_item_id, units = excluded.units, status = 'pending', error = '',
        decided_by = excluded.decided_by, decided_at = now(), applied_at = null, shopify_before = null;
      q := q + 1;
    elsif x->>'decision' = 'skip' then
      insert into jt.fbm_decisions (order_id, sku, decision, variant_id, units, status, decided_by)
      values (l.order_id, l.sku, 'skip', l.variant_id, coalesce(l.units, 0), 'skipped', who)
      on conflict (order_id, sku) do update set decision = 'skip', status = 'skipped', error = '',
        decided_by = excluded.decided_by, decided_at = now(), applied_at = null;
      s := s + 1;
    else
      update jt.fbm_decisions set status = 'undone', decided_by = who, decided_at = now()
      where order_id = l.order_id and sku = l.sku and (decision = 'skip' or status = 'failed');
      if found then u := u + 1; end if;
    end if;
  end loop;
  if q > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then perform jt.dispatch_sync('fbm-inventory'); end if;
  return jsonb_build_object('queued', q, 'skipped', s, 'undone', u, 'refused', refused);
end $$;

-- 'undone' rows mean "undecided": the page treats them like no row at all.
create or replace function public.jt_fbm_decide(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.fbm_decide(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;

-- change the first day shown: p = {start: 'YYYY-MM-DD'}
create or replace function jt.fbm_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p ? 'start' and (p->>'start')::date is null then raise exception 'start must be a date'; end if;
  insert into jt.settings (key, value) values ('fbm_sync', jsonb_build_object('start', p->>'start', 'location_id', null))
  on conflict (key) do update set value = jt.settings.value || jsonb_strip_nulls(jsonb_build_object('start', p->>'start')), updated_at = now()
  returning value into v;
  return v;
end $$;
create or replace function public.jt_fbm_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.fbm_settings(p);
end $$;

revoke all on function jt.fbm_decide(jsonb), jt.fbm_settings(jsonb) from public;
revoke all on function public.jt_fbm_decide(jsonb), public.jt_fbm_settings(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_fbm_decide(jsonb), public.jt_fbm_settings(jsonb) from anon;
    grant execute on function public.jt_fbm_decide(jsonb), public.jt_fbm_settings(jsonb) to authenticated;
  end if;
end $$;
