-- Building Amazon tab days from Finances API lines: release copies and bank payouts no longer make a day appear
-- (a day with nothing else would have been written as an empty day).
-- p = {first, last, target: 'amzdays' | 'amzdays_api', file}
create or replace function public.jt_amazon_fin_build(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  tgt text := coalesce(p->>'target', 'amzdays');
  days jsonb;
begin
  if tgt not in ('amzdays', 'amzdays_api') then raise exception 'unknown target %', tgt; end if;
  with l as (
    select * from jt.v_amazon_fin_lines where day between (p->>'first')::date and (p->>'last')::date
      and kind in ('order', 'refund', 'other')
  ),
  sk as (   -- each day's SKU list, in order of first appearance
    select day, sku, (row_number() over (partition by day order by min(posted_at), sku) - 1)::int as ix
    from l where kind in ('order', 'refund') and sku <> '' group by day, sku
  ),
  d as (
    select l.day,
      coalesce((select jsonb_agg(s.sku order by s.ix) from sk s where s.day = l.day), '[]'::jsonb) as skus,
      coalesce(jsonb_agg(jsonb_build_array(l.hm, l.order_id, s.ix, l.qty, round(l.sales, 2), round(l.ship, 2), round(l.promo, 2),
                                           round(l.sellfees, 2), round(l.fbafees, 2), round(l.total, 2), case when l.fulfillment = 'AFN' then 1 else 0 end)
                         order by l.posted_at, l.transaction_id, l.item) filter (where l.kind = 'order'), '[]'::jsonb) as orders,
      coalesce(jsonb_agg(jsonb_build_array(l.hm, l.order_id, coalesce(s.ix, -1), abs(l.qty), round(l.sales + l.ship + l.promo, 2),
                                           round(l.sellfees + l.fbafees, 2), round(l.total, 2))
                         order by l.posted_at, l.transaction_id, l.item) filter (where l.kind = 'refund'), '[]'::jsonb) as refunds,
      coalesce((select jsonb_object_agg(o.cat, o.v) from (select cat, round(sum(total), 2) v from l l2 where l2.day = l.day and l2.kind = 'other' group by cat) o), '{}'::jsonb) as other,
      jsonb_strip_nulls(jsonb_build_object(
        'orders', count(distinct l.order_id) filter (where l.kind = 'order'),
        'units', coalesce(sum(l.qty) filter (where l.kind = 'order'), 0),
        'sales', round(coalesce(sum(l.sales) filter (where l.kind = 'order'), 0), 2),
        'ship', round(coalesce(sum(l.ship) filter (where l.kind = 'order'), 0), 2),
        'promo', round(coalesce(sum(l.promo) filter (where l.kind = 'order'), 0), 2),
        'sellfees', round(coalesce(sum(l.sellfees) filter (where l.kind = 'order'), 0), 2),
        'fbafees', round(coalesce(sum(l.fbafees) filter (where l.kind = 'order'), 0), 2),
        'orders_net', round(coalesce(sum(l.total) filter (where l.kind = 'order'), 0), 2),
        'refunds_net', round(sum(l.total) filter (where l.kind = 'refund'), 2),
        'refund_sales', round(sum(l.sales + l.ship + l.promo) filter (where l.kind = 'refund'), 2),
        'refund_units', sum(abs(l.qty)) filter (where l.kind = 'refund'),
        'other', round(sum(l.total) filter (where l.kind = 'other'), 2))) as totals
    from l left join sk s on s.day = l.day and s.sku = l.sku
    group by l.day
  )
  select coalesce(jsonb_agg(jsonb_build_object('date', to_char(day, 'YYYY-MM-DD'), 'skus', skus, 'orders', orders, 'refunds', refunds,
           'other', other, 'totals', totals, 'file', coalesce(p->>'file', 'SP-API Finances'),
           'uploadedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))), '[]'::jsonb)
  into days from d;
  if jsonb_array_length(days) = 0 then return 0; end if;
  return public.jt_amazon_fin_save(jsonb_build_object('target', tgt, 'days', days));
end $$;

