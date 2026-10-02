-- Shipments tab: when each inbound shipment reached its current status, so the page can flag shipments that sit
-- (e.g. delivered but nothing checked in for a week). AWD: Amazon's updatedAt; FBA (the v0 API has no dates): the
-- sync that first saw the new status.
alter table jt.inbound_shipments add column if not exists status_since timestamptz;
update jt.inbound_shipments set status_since = coalesce(amazon_updated, first_seen) where status_since is null;
alter table jt.inbound_shipments alter column status_since set default now();

create or replace function public.jt_inbound_shipments_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare s jsonb; n int := 0;
begin
  for s in select * from jsonb_array_elements(coalesce(p->'shipments', '[]'::jsonb)) loop
    insert into jt.inbound_shipments as t (id, kind, name, status, destination, created_at, amazon_updated, carrier, tracking, raw, synced_at, status_since)
    values (s->>'id', s->>'kind', coalesce(s->>'name', ''), coalesce(s->>'status', ''), coalesce(s->>'destination', ''),
            nullif(s->>'created_at', '')::timestamptz, nullif(s->>'updated', '')::timestamptz, coalesce(s->>'carrier', ''),
            coalesce(s->>'tracking', ''), s->'raw', now(), coalesce(nullif(s->>'updated', '')::timestamptz, now()))
    on conflict (id) do update set name = excluded.name, status = excluded.status,
      status_since = case when t.status is distinct from excluded.status then coalesce(excluded.amazon_updated, now()) else t.status_since end, destination = excluded.destination,
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
