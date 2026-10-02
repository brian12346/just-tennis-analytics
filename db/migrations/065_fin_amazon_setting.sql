-- Cash flow: Amazon payouts are estimated from last year's sales for the same two weeks; the 'amazon' setting holds
-- {vs_last_year: percent} (100 = same as last year) to scale that up or down.
create or replace function fin.settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p->>'key' not in ('cash', 'shopify', 'amazon') then raise exception 'unknown setting %', p->>'key'; end if;
  insert into fin.settings (key, value) values (p->>'key', coalesce(p->'value', '{}'::jsonb))
  on conflict (key) do update set value = fin.settings.value || coalesce(p->'value', '{}'::jsonb), updated_at = now()
  returning value into v;
  return v;
end $$;
revoke all on function fin.settings_set(jsonb) from public;
