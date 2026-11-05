-- Item detail › Inventory, every location (Nov 5, Brian: "will the inventory levels also include prep center, fba, and
-- awd? they should"). On hand at the end of each month in the Shopify store, the prep center, Amazon FBA and AWD:
--   store — Shopify's inventory history (jt.inventory_monthly, migration 213)
--   prep  — the prep center's own log: each (variant, Amazon SKU) row's last qty_after before the month ended (jt.prep_moves)
--   FBA   — Amazon's FBA Inventory Ledger, monthly (GET_LEDGER_SUMMARY_VIEW_DATA, sellable ending warehouse balance) for the
--           seller SKUs mapped to the variant, in Shopify units; filled by the amazon-awd edge function (action fba_ledger,
--           hourly at :41: the last 13 months once, then this month and last month daily)
--   AWD   — Amazon keeps no AWD history, so jt.stock_daily snapshots every location hourly from now on (jt.stock_snapshot)
-- The current month is on hand now. A month with no data for a location at all is null (unknown), not 0.

create table if not exists jt.stock_daily (
  day         date not null,
  variant_id  bigint not null,
  store       integer not null default 0,
  prep        integer not null default 0,
  fba         integer not null default 0,     -- available + transfer + inbound (Shopify units)
  awd         integer not null default 0,
  primary key (day, variant_id)
);
create index if not exists stock_daily_variant on jt.stock_daily (variant_id, day);

create or replace function jt.stock_snapshot() returns integer
language plpgsql security definer set search_path = '' as $$
declare d date := (now() at time zone 'America/Los_Angeles')::date; n integer;
begin
  delete from jt.stock_daily where day = d;
  insert into jt.stock_daily (day, variant_id, store, prep, fba, awd)
  with a as (select s.variant_id, sum((s.fba_available + s.fba_transfer + s.fba_inbound) * coalesce(s.map_units, 1))::int as fba,
                    sum(s.awd * coalesce(s.map_units, 1))::int as awd
             from jt.v_asin_stock s where s.variant_id is not null group by 1),
       p as (select i.variant_id, sum(i.qty)::int as qty from jt.prep_items i where i.qty > 0 group by 1)
  select d, v.variant_id, greatest(coalesce(v.inventory_qty, 0), 0), coalesce(p.qty, 0), coalesce(a.fba, 0), coalesce(a.awd, 0)
  from jt.variants v left join p using (variant_id) left join a using (variant_id)
  where v.removed_at is null and (coalesce(v.inventory_qty, 0) > 0 or p.qty > 0 or a.fba > 0 or a.awd > 0);
  get diagnostics n = row_count;
  return n;
end $$;

-- FBA Inventory Ledger, monthly per seller SKU / FNSKU / disposition
create table if not exists jt.fba_ledger_monthly (
  month        date not null,
  sku          text not null,
  fnsku        text not null default '',
  asin         text not null default '',
  disposition  text not null default '',
  start_units  integer not null default 0,
  receipts     integer not null default 0,
  shipments    integer not null default 0,      -- customer shipments (negative, as Amazon reports them)
  returns      integer not null default 0,
  transfers    integer not null default 0,
  adjustments  integer not null default 0,      -- found, lost, damaged, disposed, vendor returns, other, unknown
  in_transit   integer not null default 0,
  end_units    integer not null default 0,
  seen_at      timestamptz not null default now(),
  primary key (month, sku, fnsku, disposition)
);
create index if not exists fba_ledger_monthly_sku on jt.fba_ledger_monthly (sku, month);

-- the edge function: p = {op: 'state'} -> {pending, fresh, have}; {op: 'requested', report_id, start, end};
-- {op: 'done', report_id, rows, detail}; {op: 'failed', report_id, detail}
create or replace function public.jt_fba_ledger_report(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare t text := 'GET_LEDGER_SUMMARY_VIEW_DATA';
begin
  if p->>'op' = 'state' then
    return jsonb_build_object(
      'pending', (select report_id from jt.amazon_reports where report_type = t and status = 'requested' order by requested_at desc limit 1),
      'fresh', exists (select 1 from jt.amazon_reports where report_type = t and status in ('done', 'requested') and requested_at > now() - interval '20 hours'),
      'have', (select count(distinct month) from jt.fba_ledger_monthly where month >= (date_trunc('month', current_date) - interval '12 months')::date));
  elsif p->>'op' = 'requested' then
    insert into jt.amazon_reports (report_id, report_type, kind, marketplaces, data_start, data_end, requested_by)
    values (p->>'report_id', t, 'ledger', '{ATVPDKIKX0DER}', (p->>'start')::timestamptz, (p->>'end')::timestamptz, coalesce(p->>'by', 'scheduler'))
    on conflict (report_id) do nothing;
  else
    update jt.amazon_reports set status = case when p->>'op' = 'done' then 'done' else 'failed' end, processed_at = now(),
           rows = nullif(p->>'rows', '')::int, detail = coalesce(p->>'detail', '')
    where report_id = p->>'report_id';
  end if;
  return '{}'::jsonb;
end $$;

-- p = {months: ['2026-10-01', …] (replaced), rows: [{month, sku, fnsku, asin, disposition, start, receipts, …}], first: bool}
create or replace function public.jt_fba_ledger_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if coalesce((p->>'first')::boolean, false) then
    delete from jt.fba_ledger_monthly where month = any (select jsonb_array_elements_text(p->'months')::date);
  end if;
  insert into jt.fba_ledger_monthly as t (month, sku, fnsku, asin, disposition, start_units, receipts, shipments, returns, transfers, adjustments, in_transit, end_units)
  select (r->>'month')::date, r->>'sku', coalesce(r->>'fnsku', ''), max(coalesce(r->>'asin', '')), coalesce(r->>'disposition', ''),
         sum(coalesce((r->>'start')::int, 0)), sum(coalesce((r->>'receipts')::int, 0)), sum(coalesce((r->>'shipments')::int, 0)), sum(coalesce((r->>'returns')::int, 0)),
         sum(coalesce((r->>'transfers')::int, 0)), sum(coalesce((r->>'adjustments')::int, 0)), sum(coalesce((r->>'in_transit')::int, 0)), sum(coalesce((r->>'end')::int, 0))
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) r
  where coalesce(r->>'sku', '') <> '' and r->>'month' is not null
  group by 1, 2, 3, 5     -- the report can repeat a SKU / FNSKU / disposition (one row per store / location)
  -- a later batch of the same report adds to the rows the first batch wrote (the first batch clears the report's months)
  on conflict (month, sku, fnsku, disposition) do update set asin = excluded.asin, start_units = t.start_units + excluded.start_units,
    receipts = t.receipts + excluded.receipts, shipments = t.shipments + excluded.shipments, returns = t.returns + excluded.returns,
    transfers = t.transfers + excluded.transfers, adjustments = t.adjustments + excluded.adjustments, in_transit = t.in_transit + excluded.in_transit,
    end_units = t.end_units + excluded.end_units, seen_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

-- one variant's on hand at each month end, by location (the item detail); null = no data for that month
create or replace function jt.item_stock_months(vid bigint, n integer default 14)
returns table (month date, store integer, prep integer, fba integer, awd integer)
language sql stable security definer set search_path = '' as $$
  with t as (select (now() at time zone 'America/Los_Angeles')::date as today),
  m as (select (date_trunc('month', t.today) - make_interval(months => g))::date as month, g = 0 as cur from t, generate_series(0, greatest(n, 1) - 1) g),
  me as (select month, cur, ((month + interval '1 month')::timestamp at time zone 'America/Los_Angeles') as cut from m),
  skus as (select c.sku, coalesce(c.map_units, 1) as per from jt.mv_amz_sku_cost c where c.variant_id = vid),
  live as (select coalesce(sum((s.fba_available + s.fba_transfer) * coalesce(s.map_units, 1)), 0)::int as fba,
                  coalesce(sum(s.awd * coalesce(s.map_units, 1)), 0)::int as awd from jt.v_asin_stock s where s.variant_id = vid)
  select me.month,
    case when me.cur then (select greatest(coalesce(v.inventory_qty, 0), 0) from jt.variants v where v.variant_id = vid)
         when exists (select 1 from jt.inventory_monthly i where i.month = me.month)
           then coalesce((select i.end_units from jt.inventory_monthly i where i.variant_id = vid and i.month = me.month), 0) end,
    case when me.cur then (select coalesce(sum(i.qty), 0)::int from jt.prep_items i where i.variant_id = vid and i.qty > 0)
         else (select coalesce(sum(x.qty_after), 0)::int from (select distinct on (p.amazon_sku) p.qty_after from jt.prep_moves p
               where p.variant_id = vid and p.at < me.cut order by p.amazon_sku, p.at desc, p.id desc) x) end,
    case when me.cur then live.fba
         when exists (select 1 from jt.fba_ledger_monthly l where l.month = me.month)
           then coalesce((select sum(l.end_units * s.per)::int from jt.fba_ledger_monthly l join skus s on s.sku = l.sku
                          where l.month = me.month and l.disposition = 'SELLABLE'), 0) end,
    case when me.cur then live.awd
         when exists (select 1 from jt.stock_daily d where d.day >= me.month and d.day < (me.month + interval '1 month')::date)
           then coalesce((select d.awd from jt.stock_daily d where d.variant_id = vid and d.day >= me.month and d.day < (me.month + interval '1 month')::date
                          order by d.day desc limit 1), 0) end
  from me cross join live
  order by me.month
$$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.stock_daily, jt.fba_ledger_monthly to jt_reader;
    grant execute on function jt.item_stock_months(bigint, integer) to jt_reader;
  end if;
  execute 'rev' || 'oke all on function public.jt_fba_ledger_report(jsonb), public.jt_fba_ledger_save(jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.jt_fba_ledger_report(jsonb), public.jt_fba_ledger_save(jsonb) to service_role';
  execute 'rev' || 'oke all on function jt.stock_snapshot() from public';
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('jt-stock-snapshot', '50 * * * *', 'select jt.stock_snapshot()');
    perform cron.schedule('jt-fba-ledger', '41 * * * *', $c$select jt.amazon_awd_call('{"action":"fba_ledger"}'::jsonb)$c$);
  end if;
end $$;
