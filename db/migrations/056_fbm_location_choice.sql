-- FBM stock: choose the Shopify location on the page. The sync job saves the store's locations (with names, now that
-- the app has read_locations) in jt.settings fbm_sync.locations; location_id must be one of them.
-- p = {start?: 'YYYY-MM-DD', location_name?: text, location_id?: gid}
create or replace function jt.fbm_settings(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb; known jsonb;
begin
  if p ? 'start' and (p->>'start')::date is null then raise exception 'start must be a date'; end if;
  if p ? 'location_name' and length(coalesce(p->>'location_name', '')) > 80 then raise exception 'location name is too long'; end if;
  insert into jt.settings (key, value) values ('fbm_sync', jsonb_build_object('start', coalesce(p->>'start', '2026-09-25')))
  on conflict (key) do nothing;
  if p ? 'location_id' then
    select value->'locations' into known from jt.settings where key = 'fbm_sync';
    if not exists (select 1 from jsonb_array_elements(coalesce(known, '[]'::jsonb)) x where x->>'id' = p->>'location_id') then
      raise exception 'that location is not one of the store''s active locations';
    end if;
  end if;
  update jt.settings set value = value
      || jsonb_strip_nulls(jsonb_build_object('start', p->>'start', 'location_id', p->>'location_id'))
      || case when p ? 'location_name' then jsonb_build_object('location_name', btrim(p->>'location_name')) else '{}'::jsonb end,
    updated_at = now()
  where key = 'fbm_sync'
  returning value into v;
  return v;
end $$;
