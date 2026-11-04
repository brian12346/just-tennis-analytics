-- 205: AWD inventory from Amazon's AWD API (2024-05-09 listInventory), hourly.
-- Edge function `amazon-awd` reads every SKU's AWD quantities (units) and calls jt_awd_inventory_save, which
--  * keeps the latest numbers per SKU in jt.awd_inventory (SKUs Amazon no longer lists go to 0 / inactive), and
--  * rewrites the 'awdinv' doc in the same row shape the AWD report upload uses
--    [sku, fnsku, asin, name, inbound, available, reserved, researching, outbound to FBA],
--    so every existing reader (v_asin_fba -> v_asin_stock, the Amazon inventory tab, ASIN mapping) gets live AWD.
-- The manual AWD upload still works; the next hourly pull replaces it.

create table if not exists jt.awd_inventory (
  sku           text primary key,
  onhand        integer not null default 0,   -- totalOnhandQuantity (available + reserved)
  available     integer not null default 0,   -- availableDistributableQuantity
  reserved      integer not null default 0,   -- reservedDistributableQuantity
  inbound       integer not null default 0,   -- totalInboundQuantity
  replenishment integer not null default 0,   -- replenishmentQuantity (on its way from AWD to FBA)
  active        boolean not null default true,
  synced_at     timestamptz not null default now()
);
alter table jt.awd_inventory enable row level security;

create or replace function public.jt_awd_inventory_save(p jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare n int := 0; old_rows jsonb; new_rows jsonb;
begin
  insert into jt.awd_inventory (sku, onhand, available, reserved, inbound, replenishment, active, synced_at)
  select x->>'sku', coalesce((x->>'onhand')::int, 0), coalesce((x->>'available')::int, 0), coalesce((x->>'reserved')::int, 0),
         coalesce((x->>'inbound')::int, 0), coalesce((x->>'replenishment')::int, 0), true, now()
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x
  where coalesce(x->>'sku', '') <> ''
  on conflict (sku) do update set onhand = excluded.onhand, available = excluded.available, reserved = excluded.reserved,
    inbound = excluded.inbound, replenishment = excluded.replenishment, active = true, synced_at = now();
  get diagnostics n = row_count;

  if (p->>'complete')::boolean then
    update jt.awd_inventory set active = false, onhand = 0, available = 0, reserved = 0, inbound = 0, replenishment = 0
    where active and not (sku = any (array(select jsonb_array_elements_text(coalesce(p->'skus', '[]'::jsonb)))));

    -- the 'awdinv' doc, in the upload's row shape (only rewritten when the numbers changed)
    select coalesce(jsonb_agg(jsonb_build_array(a.sku, coalesce(f.fnsku, ''), coalesce(nullif(f.asin, ''), s.asin, ''),
             coalesce(nullif(f.name, ''), s.title, ''), a.inbound, a.available, a.reserved, 0, a.replenishment) order by a.sku), '[]'::jsonb)
      into new_rows
    from jt.awd_inventory a
      left join jt.fba_inventory f on f.sku = a.sku
      left join jt.v_amz_sku_asin s on s.sku = a.sku
    where a.active and (a.onhand + a.inbound + a.replenishment) > 0;
    select data->'rows' into old_rows from jt.docs where collection = 'awdinv' and id = 'c000';
    if old_rows is distinct from new_rows then
      delete from jt.docs where collection = 'awdinv' and id <> 'c000';
      insert into jt.docs (collection, id, data, updated_at)
      values ('awdinv', 'c000', jsonb_build_object('file', 'Amazon API · AWD inventory', 'source', 'api',
              'snapshot', to_char(now() at time zone 'America/Los_Angeles', 'YYYY-MM-DD'),
              'uploadedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
              'total', jsonb_array_length(new_rows), 'rows', new_rows), now())
      on conflict (collection, id) do update set data = excluded.data, updated_at = now();
    end if;
    insert into jt.settings (key, value) values ('awd_inventory', jsonb_build_object('synced_at', now(),
      'skus', jsonb_array_length(coalesce(p->'skus', '[]'::jsonb)), 'doc_rows', jsonb_array_length(new_rows)))
    on conflict (key) do update set value = excluded.value;
  end if;
  return n;
end $function$;

revoke all on function public.jt_awd_inventory_save(jsonb) from public, anon, authenticated;
grant execute on function public.jt_awd_inventory_save(jsonb) to service_role;

-- SQL / scheduler entry point for the edge function
create or replace function jt.amazon_awd_call(p jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path to ''
as $function$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/amazon-awd', body := p, timeout_milliseconds := 120000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $function$;

select cron.schedule('jt-amazon-awd', '15 * * * *', $$select jt.amazon_awd_call('{"action":"awd_inventory"}'::jsonb)$$);
