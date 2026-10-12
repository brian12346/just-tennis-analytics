-- "Sync from Shopify" on the Purchase orders tab: starts the sync's shopify-pos job (Shopify POs + what's been received
-- on them) now instead of waiting for the hourly run. Asked again within 3 minutes, it doesn't start a second run.
-- Returns {requested_at, already}; the page watches jt.sync_runs for the shopify_pos step finishing after requested_at.
create or replace function public.jt_request_shopify_pos() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare last timestamptz;
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  select max(requested_at) into last from jt.sync_dispatches where job = 'shopify-pos' and requested_at > now() - interval '3 minutes';
  if last is not null then return jsonb_build_object('requested_at', last, 'already', true); end if;
  if to_regprocedure('jt.dispatch_sync(text)') is null then return jsonb_build_object('requested_at', null, 'already', false); end if;
  perform jt.dispatch_sync('shopify-pos');
  return jsonb_build_object('requested_at', now(), 'already', false);
end $$;

revoke all on function public.jt_request_shopify_pos() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_request_shopify_pos() from anon;
    grant execute on function public.jt_request_shopify_pos() to authenticated;
  end if;
end $$;
