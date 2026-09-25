-- Keep the product list in step with Shopify: variants deleted in Shopify are marked removed (not deleted here,
-- so sales history, Amazon mappings and cost history still resolve), and the dashboard can ask for a catalog sync.

alter table jt.variants add column if not exists removed_at timestamptz;   -- set when a catalog sync no longer sees it
create index if not exists variants_live_idx on jt.variants (status) where removed_at is null;

-- "Sync from Shopify" in the dashboard: start the catalog job now (at most once a minute). Returns true if started.
create or replace function jt.request_catalog_sync() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if to_regprocedure('jt.dispatch_sync(text)') is null then return false; end if;
  if to_regclass('jt.sync_dispatches') is not null
     and exists (select 1 from jt.sync_dispatches where job = 'catalog' and requested_at > now() - interval '1 minute') then
    return false;
  end if;
  perform jt.dispatch_sync('catalog');
  return true;
end $$;
revoke all on function jt.request_catalog_sync() from public;

create or replace function public.jt_request_catalog_sync() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.request_catalog_sync();
end $$;
revoke all on function public.jt_request_catalog_sync() from public, anon;
grant execute on function public.jt_request_catalog_sync() to authenticated;
