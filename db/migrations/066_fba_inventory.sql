-- FBA inventory from the SP-API (FBA Inventory API, amazon.com pool), saved hourly by the amazon function's
-- fba_inventory action. Replaces uploading the FBA Inventory report for forecasting (the upload still works on the
-- Amazon inventory tab). One row per seller SKU.
create table if not exists jt.fba_inventory (
  sku                 text primary key,
  asin                text not null default '',
  fnsku               text not null default '',
  name                text not null default '',
  condition           text not null default '',
  fulfillable         integer not null default 0,   -- available to sell
  inbound_working     integer not null default 0,   -- shipment created, not shipped yet
  inbound_shipped     integer not null default 0,   -- on the way to Amazon
  inbound_receiving   integer not null default 0,   -- arrived, being received
  reserved_total      integer not null default 0,
  reserved_customer   integer not null default 0,   -- already sold (pending customer orders)
  reserved_transfer   integer not null default 0,   -- moving between Amazon warehouses
  reserved_processing integer not null default 0,   -- being processed at the warehouse
  researching         integer not null default 0,
  unfulfillable       integer not null default 0,
  total               integer not null default 0,
  amazon_updated      timestamptz,
  active              boolean not null default true, -- false = no longer returned by Amazon
  synced_at           timestamptz not null default now()
);
create index if not exists fba_inventory_asin on jt.fba_inventory (asin);

-- p = {rows: [...], complete: false} saves rows; {complete: true, skus: [all skus returned]} marks the rest inactive
-- (zeroed) and records the sync time in jt.settings 'fba_inventory'.
create or replace function public.jt_fba_inventory_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int := 0;
begin
  insert into jt.fba_inventory (sku, asin, fnsku, name, condition, fulfillable, inbound_working, inbound_shipped, inbound_receiving,
    reserved_total, reserved_customer, reserved_transfer, reserved_processing, researching, unfulfillable, total, amazon_updated, active, synced_at)
  select x->>'sku', coalesce(x->>'asin', ''), coalesce(x->>'fnsku', ''), coalesce(x->>'name', ''), coalesce(x->>'condition', ''),
         coalesce((x->>'fulfillable')::int, 0), coalesce((x->>'inbound_working')::int, 0), coalesce((x->>'inbound_shipped')::int, 0),
         coalesce((x->>'inbound_receiving')::int, 0), coalesce((x->>'reserved_total')::int, 0), coalesce((x->>'reserved_customer')::int, 0),
         coalesce((x->>'reserved_transfer')::int, 0), coalesce((x->>'reserved_processing')::int, 0), coalesce((x->>'researching')::int, 0),
         coalesce((x->>'unfulfillable')::int, 0), coalesce((x->>'total')::int, 0), nullif(x->>'updated', '')::timestamptz, true, now()
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x
  where coalesce(x->>'sku', '') <> ''
  on conflict (sku) do update set asin = excluded.asin, fnsku = excluded.fnsku, name = excluded.name, condition = excluded.condition,
    fulfillable = excluded.fulfillable, inbound_working = excluded.inbound_working, inbound_shipped = excluded.inbound_shipped,
    inbound_receiving = excluded.inbound_receiving, reserved_total = excluded.reserved_total, reserved_customer = excluded.reserved_customer,
    reserved_transfer = excluded.reserved_transfer, reserved_processing = excluded.reserved_processing, researching = excluded.researching,
    unfulfillable = excluded.unfulfillable, total = excluded.total, amazon_updated = excluded.amazon_updated, active = true, synced_at = now();
  get diagnostics n = row_count;
  if (p->>'complete')::boolean then
    update jt.fba_inventory set active = false, fulfillable = 0, inbound_working = 0, inbound_shipped = 0, inbound_receiving = 0,
      reserved_total = 0, reserved_customer = 0, reserved_transfer = 0, reserved_processing = 0, researching = 0, unfulfillable = 0, total = 0
    where active and not (sku = any (array(select jsonb_array_elements_text(coalesce(p->'skus', '[]'::jsonb)))));
    insert into jt.settings (key, value) values ('fba_inventory', jsonb_build_object('synced_at', now(), 'skus', jsonb_array_length(coalesce(p->'skus', '[]'::jsonb))))
    on conflict (key) do update set value = excluded.value;
  end if;
  return n;
end $$;
revoke all on function public.jt_fba_inventory_save(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then revoke all on function public.jt_fba_inventory_save(jsonb) from anon, authenticated; end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then grant execute on function public.jt_fba_inventory_save(jsonb) to service_role; end if;
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.fba_inventory to jt_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.fba_inventory to fin_reader; end if;
end $$;
