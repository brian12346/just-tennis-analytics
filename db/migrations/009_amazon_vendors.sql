-- Amazon listing -> Shopify vendor, set on the Amazon matching tab (step 1). Product matching (step 2) only looks
-- at that vendor's Shopify products. vendor '-' = the listing's product isn't sold in Shopify.
create table if not exists jt.amazon_vendors (
  sku         text primary key,              -- Amazon seller SKU
  vendor      text not null,
  updated_at  timestamptz not null default now()
);

-- p = [{"sku": "...", "vendor": "Wilson"}, ...]; vendor "" removes the row. Returns rows changed.
create or replace function jt.set_amazon_vendors(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; d integer;
begin
  delete from jt.amazon_vendors a using jsonb_array_elements(p) x
  where a.sku = x->>'sku' and coalesce(x->>'vendor', '') = '';
  get diagnostics d = row_count;
  insert into jt.amazon_vendors (sku, vendor)
  select distinct on (x->>'sku') x->>'sku', x->>'vendor'
  from jsonb_array_elements(p) with ordinality e(x, i)
  where coalesce(x->>'sku', '') <> '' and coalesce(x->>'vendor', '') <> ''
  order by x->>'sku', i desc
  on conflict (sku) do update set vendor = excluded.vendor, updated_at = now();
  get diagnostics n = row_count;
  return n + d;
end $$;
revoke all on function jt.set_amazon_vendors(jsonb) from public;

create or replace function public.jt_set_amazon_vendors(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.set_amazon_vendors(p);
end $$;
revoke all on function public.jt_set_amazon_vendors(jsonb) from public, anon;
grant execute on function public.jt_set_amazon_vendors(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.amazon_vendors to jt_reader; end if;
end $$;
