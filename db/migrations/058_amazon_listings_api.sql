-- Amazon listings from the SP-API: the `amazon` edge function asks once a day (and on "Get from Amazon" on the
-- Amazon mapping tab) for GET_MERCHANT_LISTINGS_ALL_DATA, the same All Listings report that used to be uploaded by
-- hand, and saves it in the uploaded shape (jt.docs 'amzlistings', 450 rows per doc c000, c001, …) so every tab
-- that reads listings (Amazon mapping, FBM stock, prep center, Amazon inventory) picks it up unchanged.


-- the last listings report asked for (not failed: once a day; any: a failed one is retried after an hour)
create or replace function public.jt_amazon_state() returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'pending', coalesce((select jsonb_agg(jsonb_build_object('report_id', report_id, 'report_type', report_type, 'kind', kind, 'requested_at', requested_at,
                                                             'first_day', first_day, 'last_day', last_day) order by requested_at)
                          from jt.amazon_reports where status = 'requested'), '[]'::jsonb),
    'queued', coalesce((select jsonb_agg(jsonb_build_object('report_id', report_id, 'report_type', report_type, 'kind', kind, 'data_start', data_start, 'data_end', data_end) order by data_start)
                          from jt.amazon_reports where status = 'queued'), '[]'::jsonb),
    'last_recent', (select max(requested_at) from jt.amazon_reports where kind = 'recent' and status <> 'failed'),
    'last_listings', (select max(requested_at) from jt.amazon_reports where kind = 'listings' and status <> 'failed'),
    'last_listings_any', (select max(requested_at) from jt.amazon_reports where kind = 'listings'),
    'lines', (select count(*) from jt.amazon_order_lines),
    'first_purchase', (select min(purchase_at) from jt.amazon_order_lines),
    'last_purchase', (select max(purchase_at) from jt.amazon_order_lines));
$$;

-- p = {file, at, rows: [[sku, asin, title, price, qty, channel, status, open_date], …]}
-- Writes the listings in 450-row docs; docs past the new last one are emptied (rows []). Refuses a report with fewer
-- than half the listings already saved, so a bad or partial report can't wipe the list. Returns the rows saved.
create or replace function public.jt_amazon_listings_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  ch constant int := 450;
  total int := coalesce(jsonb_array_length(p->'rows'), 0);
  have int := (select coalesce(sum(jsonb_array_length(data->'rows')), 0) from jt.docs where collection = 'amzlistings');
  n int := ceil(total / ch::numeric);
  meta jsonb := jsonb_build_object('file', coalesce(p->>'file', 'SP-API listings'), 'uploadedAt', coalesce(p->>'at', to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')), 'total', total);
begin
  if total = 0 or total < have / 2 then
    raise exception 'listings report has % rows, % saved now — not replacing', total, have;
  end if;
  for i in 0 .. n - 1 loop
    insert into jt.docs (collection, id, data, updated_at)
    values ('amzlistings', 'c' || lpad(i::text, 3, '0'),
            meta || jsonb_build_object('rows', jsonb_path_query_array(p->'rows', ('$[' || i * ch || ' to ' || least((i + 1) * ch, total) - 1 || ']')::jsonpath)), now())
    on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  end loop;
  update jt.docs set data = meta || jsonb_build_object('rows', '[]'::jsonb), updated_at = now()
  where collection = 'amzlistings' and id > 'c' || lpad((n - 1)::text, 3, '0') and jsonb_array_length(coalesce(data->'rows', '[]'::jsonb)) > 0;
  return total;
end $$;

revoke all on function public.jt_amazon_listings_save(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_amazon_state(), public.jt_amazon_listings_save(jsonb) from anon, authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_amazon_state(), public.jt_amazon_listings_save(jsonb) to service_role;
  end if;
end $$;
