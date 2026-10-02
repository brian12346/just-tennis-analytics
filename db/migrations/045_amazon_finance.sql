-- Amazon Transaction reports from SP-API (GET_DATE_RANGE_FINANCIAL_TRANSACTION_DATA): the `amazon` edge function
-- turns each report into the Amazon tab's days exactly like the in-page upload does, and saves them here.
alter table jt.amazon_reports add column if not exists first_day date;
alter table jt.amazon_reports add column if not exists last_day date;

create or replace function public.jt_amazon_state() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'pending', coalesce((select jsonb_agg(jsonb_build_object('report_id', report_id, 'report_type', report_type, 'kind', kind, 'requested_at', requested_at,
                                                             'first_day', first_day, 'last_day', last_day) order by requested_at)
                          from jt.amazon_reports where status = 'requested'), '[]'::jsonb),
    'queued', coalesce((select jsonb_agg(jsonb_build_object('report_id', report_id, 'report_type', report_type, 'kind', kind, 'data_start', data_start, 'data_end', data_end) order by data_start)
                          from jt.amazon_reports where status = 'queued'), '[]'::jsonb),
    'last_recent', (select max(requested_at) from jt.amazon_reports where kind = 'recent' and status <> 'failed'),
    'lines', (select count(*) from jt.amazon_order_lines),
    'first_purchase', (select min(purchase_at) from jt.amazon_order_lines),
    'last_purchase', (select max(purchase_at) from jt.amazon_order_lines));
$$;

-- the whole days a finance report covers: p = {report_ids: [...], first_day, last_day}
create or replace function public.jt_amazon_report_days(p jsonb) returns integer
language sql security definer set search_path = '' as $$
  with u as (
    update jt.amazon_reports set first_day = (p->>'first_day')::date, last_day = (p->>'last_day')::date
    where report_id in (select jsonb_array_elements_text(p->'report_ids')) returning 1)
  select count(*)::int from u;
$$;

-- p = {target: 'amzdays' | 'amzdays_api', days: [{date, skus, orders, refunds, other, totals, file, uploadedAt}]}
-- Saves each day (replacing it), then rebuilds the month summaries (amzmonths) the days fall in — the same summary
-- the in-page upload writes: skus {sku: [units, sales, total]}, totals summed over the month's days.
create or replace function public.jt_amazon_fin_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  tgt text := coalesce(p->>'target', 'amzdays');
  mcol text := case when tgt = 'amzdays' then 'amzmonths' else 'amzmonths_api' end;
  n integer := 0;
  mo text;
begin
  if tgt not in ('amzdays', 'amzdays_api') then raise exception 'unknown target %', tgt; end if;
  insert into jt.docs (collection, id, data, updated_at)
  select tgt, d->>'date', d, now() from jsonb_array_elements(p->'days') d
  where d->>'date' ~ '^\d{4}-\d{2}-\d{2}$'
  on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  get diagnostics n = row_count;
  for mo in select distinct left(d->>'date', 7) from jsonb_array_elements(p->'days') d loop
    insert into jt.docs (collection, id, data, updated_at)
    select mcol, mo, jsonb_build_object(
             'month', mo, 'firstDay', min(x.id), 'lastDay', max(x.id), 'days', count(*),
             'skus', coalesce((select jsonb_object_agg(s.sku, jsonb_build_array(s.units, round(s.sales, 2), round(s.total, 2)))
                               from (select dd.data->'skus'->>((o->>2)::int) as sku, sum((o->>3)::numeric) as units,
                                            sum((o->>4)::numeric) as sales, sum((o->>9)::numeric) as total
                                     from jt.docs dd, jsonb_array_elements(dd.data->'orders') o
                                     where dd.collection = tgt and dd.id like mo || '-%'
                                     group by 1) s where s.sku is not null), '{}'::jsonb),
             'totals', coalesce((select jsonb_object_agg(t.k, round(t.v, 2))
                                 from (select e.key as k, sum(e.value::numeric) as v
                                       from jt.docs dd, jsonb_each_text(dd.data->'totals') e
                                       where dd.collection = tgt and dd.id like mo || '-%'
                                       group by 1) t), '{}'::jsonb),
             'updatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), now()
    from jt.docs x where x.collection = tgt and x.id like mo || '-%'
    on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  end loop;
  return n;
end $$;

revoke all on function public.jt_amazon_report_days(jsonb), public.jt_amazon_fin_save(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_amazon_report_days(jsonb), public.jt_amazon_fin_save(jsonb) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_amazon_report_days(jsonb), public.jt_amazon_fin_save(jsonb) to service_role;
  end if;
end $$;
