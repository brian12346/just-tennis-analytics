-- 206: before the hourly AWD API pull (migration 205) rewrites the 'awdinv' doc, a manually uploaded AWD report
-- there is copied to jt.docs 'awdinv_upload' (id = its snapshot date), so uploads are kept for comparison.

create or replace function public.jt_awd_inventory_save(p jsonb)
returns integer
language plpgsql
security definer
set search_path to ''
as $function$
declare n int := 0; old_rows jsonb; new_rows jsonb; old_doc jsonb;
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
    select data->'rows', data into old_rows, old_doc from jt.docs where collection = 'awdinv' and id = 'c000';
    if old_rows is distinct from new_rows then
      -- keep the last manual upload before the API copy replaces it
      if old_doc is not null and coalesce(old_doc->>'source', '') <> 'api' then
        insert into jt.docs (collection, id, data, updated_at)
        values ('awdinv_upload', coalesce(nullif(old_doc->>'snapshot', ''), 'last'), old_doc, now())
        on conflict (collection, id) do update set data = excluded.data, updated_at = now();
      end if;
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

