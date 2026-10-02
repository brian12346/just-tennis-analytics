-- Rebuilding a month summary (amzmonths) read each day document again for every order line in it (~22,000 times
-- for a month), which took ~4 s and, with September in the window, pushed "Refresh from Amazon" past the 8-second
-- limit on web calls. Reading each day once (materialized) takes ~40 ms.
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
    with days as materialized (
      select id, data->'skus' as s, data->'orders' as os, data->'totals' as t
      from jt.docs where collection = tgt and id like mo || '-%'
    )
    insert into jt.docs (collection, id, data, updated_at)
    select mcol, mo, jsonb_build_object(
             'month', mo,
             'firstDay', (select min(id) from days), 'lastDay', (select max(id) from days), 'days', (select count(*) from days),
             'skus', coalesce((select jsonb_object_agg(x.sku, jsonb_build_array(x.units, round(x.sales, 2), round(x.total, 2)))
                               from (select d.s->>((e->>2)::int) as sku, sum((e->>3)::numeric) as units,
                                            sum((e->>4)::numeric) as sales, sum((e->>9)::numeric) as total
                                     from days d, jsonb_array_elements(d.os) e group by 1) x
                               where x.sku is not null), '{}'::jsonb),
             'totals', coalesce((select jsonb_object_agg(x.k, round(x.v, 2))
                                 from (select e.key as k, sum(e.value::numeric) as v
                                       from days d, jsonb_each_text(d.t) e group by 1) x), '{}'::jsonb),
             'updatedAt', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), now()
    on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  end loop;
  return n;
end $$;
