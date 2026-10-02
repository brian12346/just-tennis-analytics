-- Amazon inbound shipments from the SP-API, saved by the amazon function's inbound_shipments action (hourly):
-- FBA shipments (Fulfillment Inbound API v0 getShipments + getShipmentItems) and AWD shipments (AWD API
-- listInboundShipments + getInboundShipment). One row per shipment, one row per shipment + SKU.
create table if not exists jt.inbound_shipments (
  id              text primary key,                -- FBA shipment ID (FBA…) or AWD shipment ID
  kind            text not null check (kind in ('FBA', 'AWD')),
  name            text not null default '',
  status          text not null default '',        -- Amazon's status (WORKING, SHIPPED, RECEIVING, CLOSED … / CREATED, SHIPPED, IN_TRANSIT, RECEIVING, DELIVERED, CLOSED …)
  destination     text not null default '',        -- fulfillment center (FBA) or region / warehouse (AWD)
  created_at      timestamptz,                     -- AWD only (the FBA v0 API doesn't say)
  amazon_updated  timestamptz,
  carrier         text not null default '',
  tracking        text not null default '',
  units_expected  integer not null default 0,
  units_received  integer not null default 0,
  skus            integer not null default 0,
  raw             jsonb,
  first_seen      timestamptz not null default now(),
  synced_at       timestamptz not null default now()
);
create index if not exists inbound_shipments_status on jt.inbound_shipments (kind, status);

create table if not exists jt.inbound_shipment_items (
  shipment_id   text not null references jt.inbound_shipments (id) on delete cascade,
  sku           text not null,
  fnsku         text not null default '',
  qty_expected  integer not null default 0,        -- shipped (FBA) / expected (AWD)
  qty_received  integer not null default 0,
  qty_in_case   integer not null default 0,
  primary key (shipment_id, sku)
);
create index if not exists inbound_shipment_items_sku on jt.inbound_shipment_items (sku);

-- p = {shipments: [{id, kind, name, status, destination, created_at, updated, carrier, tracking, raw,
--      items: [{sku, fnsku, qty_expected, qty_received, qty_in_case}] | null}]}
-- items null = keep the saved items (the shipment's header changed only). Returns the number of shipments saved.
create or replace function public.jt_inbound_shipments_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare s jsonb; n int := 0;
begin
  for s in select * from jsonb_array_elements(coalesce(p->'shipments', '[]'::jsonb)) loop
    insert into jt.inbound_shipments as t (id, kind, name, status, destination, created_at, amazon_updated, carrier, tracking, raw, synced_at)
    values (s->>'id', s->>'kind', coalesce(s->>'name', ''), coalesce(s->>'status', ''), coalesce(s->>'destination', ''),
            nullif(s->>'created_at', '')::timestamptz, nullif(s->>'updated', '')::timestamptz, coalesce(s->>'carrier', ''),
            coalesce(s->>'tracking', ''), s->'raw', now())
    on conflict (id) do update set name = excluded.name, status = excluded.status, destination = excluded.destination,
      created_at = coalesce(excluded.created_at, t.created_at), amazon_updated = coalesce(excluded.amazon_updated, t.amazon_updated),
      carrier = excluded.carrier, tracking = excluded.tracking, raw = excluded.raw, synced_at = now();
    if jsonb_typeof(s->'items') = 'array' then
      update jt.inbound_shipment_items set qty_expected = 0, qty_received = 0
      where shipment_id = s->>'id' and (qty_expected <> 0 or qty_received <> 0);
      insert into jt.inbound_shipment_items (shipment_id, sku, fnsku, qty_expected, qty_received, qty_in_case)
      select s->>'id', i->>'sku', max(coalesce(i->>'fnsku', '')), sum(coalesce((i->>'qty_expected')::int, 0)), sum(coalesce((i->>'qty_received')::int, 0)),
             max(coalesce((i->>'qty_in_case')::int, 0))
      from jsonb_array_elements(s->'items') i where coalesce(i->>'sku', '') <> '' group by i->>'sku'   -- a SKU can be listed twice
      on conflict (shipment_id, sku) do update set fnsku = excluded.fnsku, qty_expected = excluded.qty_expected,
        qty_received = excluded.qty_received, qty_in_case = excluded.qty_in_case;
      update jt.inbound_shipments set
        units_expected = (select coalesce(sum(qty_expected), 0) from jt.inbound_shipment_items where shipment_id = s->>'id'),
        units_received = (select coalesce(sum(qty_received), 0) from jt.inbound_shipment_items where shipment_id = s->>'id'),
        skus = (select count(*) from jt.inbound_shipment_items where shipment_id = s->>'id' and qty_expected + qty_received > 0)
      where id = s->>'id';
    end if;
    n := n + 1;
  end loop;
  if p ? 'state' then
    insert into jt.settings (key, value) values ('inbound_shipments', p->'state')
    on conflict (key) do update set value = jt.settings.value || excluded.value;
  end if;
  return n;
end $$;
revoke all on function public.jt_inbound_shipments_save(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.jt_inbound_shipments_save(jsonb) from anon, authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.jt_inbound_shipments_save(jsonb) to service_role; end if;
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.inbound_shipments, jt.inbound_shipment_items to jt_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.inbound_shipments, jt.inbound_shipment_items to fin_reader; end if;
end $$;

-- {shipment id: 'STATUS|skus'} for every saved shipment (the function skips refetching closed ones that have their items)
create or replace function public.jt_inbound_shipments_known() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(id, status || '|' || skus), '{}'::jsonb) from jt.inbound_shipments
$$;
revoke all on function public.jt_inbound_shipments_known() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.jt_inbound_shipments_known() from anon, authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.jt_inbound_shipments_known() to service_role; end if;
end $$;
