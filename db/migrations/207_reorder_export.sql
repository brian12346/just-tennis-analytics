-- 207: nightly reorder export for Brit's FBA Reorder Planner (Excel for Mac).
-- Edge function `reorder-export` writes three CSVs to Dropbox (Just Tennis Inc / Operations / Amazon Operations /
-- FBA Ordering / Seller Sage Data), each with the exact column headers of the Amazon report it replaces:
--   FBA Inventory Report.csv      Amazon's GET_FBA_INVENTORY_PLANNING_DATA, as Amazon sends it (tab -> comma)
--   Business Report 365-Day.csv   rebuilt here from jt.amazon_order_lines (Amazon refuses this account the Sales &
--                                 Traffic report: Brand Analytics role). Units / sales / order items by child ASIN,
--                                 amazon.com, last 365 days, cancelled orders left out; traffic columns blank.
--   Inventory AWD.csv             jt.awd_inventory (migration 205) + jt.fba_inventory, AWD dashboard export's headers.
-- Dropbox access: PKCE refresh token in Vault 'dropbox_refresh_token' (+ 'dropbox_app_key'); no app secret.
-- Cron jt-reorder-export: every 15 minutes 12:00-13:45 UTC; the function does nothing once today's export is written
-- (jt.settings 'reorder_export'), so the later runs only pick up a report Amazon was slow to finish.

create or replace function public.jt_dropbox_creds()
returns jsonb
language sql
security definer
set search_path to ''
as $function$
  select jsonb_object_agg(name, decrypted_secret) from vault.decrypted_secrets where name in ('dropbox_refresh_token', 'dropbox_app_key');
$function$;
revoke all on function public.jt_dropbox_creds() from public, anon, authenticated;
grant execute on function public.jt_dropbox_creds() to service_role;

create or replace function public.jt_reorder_export_data()
returns jsonb
language sql
stable
security definer
set search_path to ''
as $function$
  with lines as (
    select l.asin, l.order_id, l.quantity, l.item_price, l.is_business, l.product_name
    from jt.amazon_order_lines l
    where l.marketplace = 'us' and l.order_status <> 'Cancelled' and coalesce(l.asin, '') <> ''
      and l.purchase_at >= now() - interval '365 days'
  ), biz as (
    select asin, max(product_name) as title,
      sum(quantity) as units, sum(quantity) filter (where is_business) as units_b2b,
      round(sum(item_price), 2) as sales, round(coalesce(sum(item_price) filter (where is_business), 0), 2) as sales_b2b,
      count(distinct order_id) as items, count(distinct order_id) filter (where is_business) as items_b2b
    from lines group by asin
  ), awd as (
    select a.sku, coalesce(nullif(f.name, ''), s.title, '') as name, coalesce(f.fnsku, '') as fnsku,
      coalesce(nullif(f.asin, ''), s.asin, '') as asin, a.inbound, a.available, a.reserved, a.replenishment,
      coalesce(f.fulfillable, 0) as fba_available, coalesce(f.reserved_total, 0) as fba_reserved,
      coalesce(f.reserved_customer, 0) as customer_order, coalesce(f.reserved_processing, 0) as fc_processing,
      coalesce(f.reserved_transfer, 0) as fc_transfer
    from jt.awd_inventory a
      left join jt.fba_inventory f on f.sku = a.sku
      left join jt.v_amz_sku_asin s on s.sku = a.sku
    where a.active
  )
  select jsonb_build_object(
    'business', coalesce((select jsonb_agg(jsonb_build_array(asin, asin, title, '', '', '', '', '', '', '', '', '', '',
        units, coalesce(units_b2b, 0), '', '', sales, sales_b2b, items, items_b2b) order by units desc) from biz), '[]'::jsonb),
    'awd', coalesce((select jsonb_agg(jsonb_build_array(name, sku, fnsku, asin, inbound, '', available, '', available, '',
        reserved, '', 0, '', 0, '', replenishment, fba_available, '', fba_reserved, customer_order, fc_processing, fc_transfer, '', '')
        order by sku) from awd), '[]'::jsonb),
    'awd_synced_at', (select value->>'synced_at' from jt.settings where key = 'awd_inventory'),
    'orders_through', (select max(purchase_at) from jt.amazon_order_lines where marketplace = 'us'));
$function$;
revoke all on function public.jt_reorder_export_data() from public, anon, authenticated;
grant execute on function public.jt_reorder_export_data() to service_role;

create or replace function jt.reorder_export_call(p jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path to ''
as $function$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/reorder-export', body := p, timeout_milliseconds := 150000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $function$;

select cron.schedule('jt-reorder-export', '*/15 12-13 * * *', $$select jt.reorder_export_call('{"action":"export"}'::jsonb)$$);
