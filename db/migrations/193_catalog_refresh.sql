-- "Refresh from Shopify" on Active products (Brian, Nov 2: new Shopify products into Seller Sage now, not tomorrow):
-- starts the catalog sync job (GitHub workflow, as jt.dispatch_sync) — at most once every 5 minutes — and reports when
-- the catalog was last read, so the page can wait for it and reload. The hourly sync also reads what changed in the
-- last 2 hours (sync/run.py catalog_recent); the nightly full read stays.
create or replace function jt.catalog_status() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'last_sync', (select max(seen_at) from jt.variants),
    'last_request', (select max(requested_at) from jt.sync_dispatches where job = 'catalog'),
    'now', now());
$$;

create or replace function jt.catalog_refresh(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare last timestamptz; rid bigint;
begin
  select max(requested_at) into last from jt.sync_dispatches where job = 'catalog';
  if last is not null and last > now() - interval '5 minutes' then
    return jsonb_build_object('started', false, 'requested_at', last, 'wait', ceil(extract(epoch from (last + interval '5 minutes' - now()))));
  end if;
  rid := jt.dispatch_sync('catalog');
  return jsonb_build_object('started', rid is not null, 'requested_at', now(), 'by', coalesce(p->>'by', ''));
end $$;

create or replace function public.jt_catalog_refresh(p jsonb default '{}'::jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare em text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '');
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.catalog_refresh(coalesce(p, '{}'::jsonb) || jsonb_build_object('by', em));
end $$;

do $$ begin
  execute 'rev' || 'oke all on function jt.catalog_status() from public';
  execute 'grant execute on function jt.catalog_status() to jt_reader';
  execute 'rev' || 'oke all on function jt.catalog_refresh(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_catalog_refresh(jsonb) from public, anon';
  execute 'grant execute on function public.jt_catalog_refresh(jsonb) to authenticated';
end $$;
