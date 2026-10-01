-- Database side of the `amazon` edge function (service role only): what reports are waiting, and saving
-- report requests, report outcomes and order lines.

-- {pending: [{report_id, report_type, kind}], last_recent: timestamptz, lines: n, first_day, last_day}
create or replace function public.jt_amazon_state() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'pending', coalesce((select jsonb_agg(jsonb_build_object('report_id', report_id, 'report_type', report_type, 'kind', kind, 'requested_at', requested_at) order by requested_at)
                          from jt.amazon_reports where status = 'requested'), '[]'::jsonb),
    'last_recent', (select max(requested_at) from jt.amazon_reports where kind = 'recent' and status <> 'failed'),
    'lines', (select count(*) from jt.amazon_order_lines),
    'first_purchase', (select min(purchase_at) from jt.amazon_order_lines),
    'last_purchase', (select max(purchase_at) from jt.amazon_order_lines));
$$;

-- p = {op: 'request', report_id, report_type, kind, marketplaces[], data_start, data_end, by}
--   | {op: 'report', report_id, status, rows?, detail?}
--   | {op: 'lines', report_id, lines: [{order_id, sku, …}]}   (upserts; returns the number saved)
create or replace function public.jt_amazon_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0;
begin
  if p->>'op' = 'request' then
    insert into jt.amazon_reports (report_id, report_type, kind, marketplaces, data_start, data_end, requested_by)
    values (p->>'report_id', p->>'report_type', coalesce(p->>'kind', 'recent'),
            coalesce(array(select jsonb_array_elements_text(p->'marketplaces')), '{}'),
            (p->>'data_start')::timestamptz, (p->>'data_end')::timestamptz, coalesce(p->>'by', ''))
    on conflict (report_id) do nothing;
    return 1;
  elsif p->>'op' = 'report' then
    update jt.amazon_reports set status = p->>'status', processed_at = now(),
      rows = coalesce((p->>'rows')::int, rows), detail = coalesce(p->>'detail', detail)
    where report_id = p->>'report_id';
    return 1;
  elsif p->>'op' = 'lines' then
    insert into jt.amazon_order_lines as t (order_id, sku, asin, merchant_order_id, purchase_at, last_updated_at, order_status,
      item_status, fulfillment, sales_channel, marketplace, product_name, quantity, currency, item_price, item_tax,
      shipping_price, shipping_tax, gift_wrap_price, item_promo, ship_promo, is_business, ship_state, ship_country,
      report_id, updated_at)
    select x.order_id, x.sku, coalesce(x.asin, ''), coalesce(x.merchant_order_id, ''), x.purchase_at, x.last_updated_at,
      coalesce(x.order_status, ''), coalesce(x.item_status, ''), coalesce(x.fulfillment, ''), coalesce(x.sales_channel, ''),
      coalesce(x.marketplace, ''), left(coalesce(x.product_name, ''), 500), coalesce(x.quantity, 0), coalesce(x.currency, ''),
      coalesce(x.item_price, 0), coalesce(x.item_tax, 0), coalesce(x.shipping_price, 0), coalesce(x.shipping_tax, 0),
      coalesce(x.gift_wrap_price, 0), coalesce(x.item_promo, 0), coalesce(x.ship_promo, 0), coalesce(x.is_business, false),
      coalesce(x.ship_state, ''), coalesce(x.ship_country, ''), coalesce(p->>'report_id', ''), now()
    from jsonb_to_recordset(p->'lines') as x(order_id text, sku text, asin text, merchant_order_id text, purchase_at timestamptz,
      last_updated_at timestamptz, order_status text, item_status text, fulfillment text, sales_channel text, marketplace text,
      product_name text, quantity int, currency text, item_price numeric, item_tax numeric, shipping_price numeric,
      shipping_tax numeric, gift_wrap_price numeric, item_promo numeric, ship_promo numeric, is_business boolean,
      ship_state text, ship_country text)
    where x.order_id is not null and x.sku is not null and x.purchase_at is not null
    on conflict (order_id, sku) do update set
      asin = excluded.asin, merchant_order_id = excluded.merchant_order_id, purchase_at = excluded.purchase_at,
      last_updated_at = excluded.last_updated_at, order_status = excluded.order_status, item_status = excluded.item_status,
      fulfillment = excluded.fulfillment, sales_channel = excluded.sales_channel, marketplace = excluded.marketplace,
      product_name = excluded.product_name, quantity = excluded.quantity, currency = excluded.currency,
      item_price = excluded.item_price, item_tax = excluded.item_tax, shipping_price = excluded.shipping_price,
      shipping_tax = excluded.shipping_tax, gift_wrap_price = excluded.gift_wrap_price, item_promo = excluded.item_promo,
      ship_promo = excluded.ship_promo, is_business = excluded.is_business, ship_state = excluded.ship_state,
      ship_country = excluded.ship_country, report_id = excluded.report_id, updated_at = now()
    -- an older report never overwrites a newer state of the order
    where t.last_updated_at is null or excluded.last_updated_at is null or excluded.last_updated_at >= t.last_updated_at;
    get diagnostics n = row_count;
    return n;
  end if;
  raise exception 'unknown op %', p->>'op';
end $$;

revoke all on function public.jt_amazon_state(), public.jt_amazon_save(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_amazon_state(), public.jt_amazon_save(jsonb) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_amazon_state(), public.jt_amazon_save(jsonb) to service_role;
  end if;
end $$;
