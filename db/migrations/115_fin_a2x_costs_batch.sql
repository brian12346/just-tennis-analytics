-- The per-SKU cost check counted only the last part of a big A2X cost file: the page sends a file in several calls and
-- each call became its own upload (batch), and only the latest batch counts. Now the page sends one batch id per upload.
-- p = {file, batch, rows: [{sku, cost, name}]} -> rows saved (a new upload replaces the last one)
create or replace function public.fin_a2x_costs_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare b bigint := coalesce(nullif(p->>'batch', '')::bigint, (extract(epoch from clock_timestamp()) * 1000)::bigint); n int;
  who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '');
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into fin.a2x_sku_costs (sku, cost, name, batch, uploaded_at, uploaded_by, file)
  select distinct on (trim(x->>'sku')) trim(x->>'sku'), nullif(regexp_replace(coalesce(x->>'cost', ''), '[$,\s]', '', 'g'), '')::numeric,
         coalesce(x->>'name', ''), b, now(), who, coalesce(p->>'file', '')
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x where coalesce(trim(x->>'sku'), '') <> ''
  on conflict (sku) do update set cost = excluded.cost, name = excluded.name, batch = excluded.batch, uploaded_at = excluded.uploaded_at,
    uploaded_by = excluded.uploaded_by, file = excluded.file;
  get diagnostics n = row_count;
  return n;
end $$;

-- the file already uploaded in two calls (Oct 10): one upload
update fin.a2x_sku_costs set batch = (select max(batch) from fin.a2x_sku_costs)
where file = 'Just_Tennis_-_Amazon_-_current-costs.csv' and uploaded_at > '2026-10-10' and uploaded_at < '2026-10-11'
  and batch <> (select max(batch) from fin.a2x_sku_costs);
