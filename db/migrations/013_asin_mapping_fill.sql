-- One ASIN = one product: when an Amazon seller SKU is mapped to a Shopify product (jt.docs amzmap/<docId>), every other
-- seller SKU of the same ASIN gets the same mapping. Copies are marked via = 'asin' (fromSku = where they came from) and
-- follow later changes to the source; a sibling mapped by hand is never overwritten.
--
-- SKU -> ASIN comes from the All Listings report (amzlistings), the FBA and AWD inventory reports (fbainv, awdinv), the
-- prep center starting file (prepseed) and the mappings themselves.

create or replace function jt.amz_docid(s text) returns text language sql immutable as $$
  -- same as docId() in the dashboard: "s_" + SKU with characters outside [A-Za-z0-9_-.:@+] as ~hex
  select 's_' || left(string_agg(case when ch ~ '[A-Za-z0-9_.:@+-]' then ch else '~' || lpad(to_hex(ascii(ch)), 2, '0') end, '' order by i), 190)
  from regexp_split_to_table(s, '') with ordinality t(ch, i) $$;

create or replace view jt.v_amz_sku_asin as
select distinct on (sku) sku, asin, title from (
  select r->>0 sku, nullif(r->>1, '') asin, nullif(r->>2, '') title, 1 pri from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'amzlistings'
  union all select r->>0, nullif(r->>2, ''), nullif(r->>3, ''), 2 from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'fbainv'
  union all select r->>0, nullif(r->>2, ''), nullif(r->>3, ''), 3 from jt.docs d, jsonb_array_elements(d.data->'rows') r where d.collection = 'awdinv'
  union all select trim(k), nullif(r->>1, ''), null, 4 from jt.docs d, jsonb_array_elements(d.data->'rows') r, unnest(string_to_array(r->>0, ',')) k where d.collection = 'prepseed'
  union all select data->>'sku', nullif(data->>'asin', ''), data->>'title', 5 from jt.docs where collection = 'amzmap'
) x where asin ~ '^[A-Z0-9]{10}$' and coalesce(sku, '') <> ''
order by sku, pri;

-- Copy mappings to sibling SKUs. p_sku given: copy that SKU's mapping to its ASIN's siblings (insert missing ones,
-- update earlier automatic copies). p_sku null: fill every ASIN whose mapped SKUs all agree. Returns rows written.
create or replace function jt.fill_asin_mappings(p_sku text default null) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer := 0; k integer;
begin
  with sa as (select * from jt.v_amz_sku_asin),
  mp as (select data->>'sku' sku, data,
           case when data->>'kind' = 'shopify' then 's:' || (regexp_match(data->>'variantId', '(\d+)$'))[1] || 'x' || coalesce(data->>'units', '1')
                when data->>'kind' = 'manual' then 'm:' || coalesce(data->>'manualCost', '') end sig
         from jt.docs where collection = 'amzmap'),
  tpl as (   -- the mapping to copy, per ASIN
    select sa.asin, mp.data from sa join mp using (sku) where p_sku is not null and sa.sku = p_sku and coalesce(mp.data->>'via', '') <> 'asin'
    union all
    select asin, (array_agg(mp.data order by mp.data->>'updatedAt' desc))[1]
    from sa join mp using (sku) where p_sku is null group by asin having count(distinct mp.sig) = 1),
  tgt as (
    select sa.sku, sa.asin, sa.title, tpl.data tpl, mp.data cur
    from tpl join sa using (asin) left join mp on mp.sku = sa.sku
    where sa.sku <> tpl.data->>'sku' and (mp.sku is null or (p_sku is not null and mp.data->>'via' = 'asin' and mp.sig is distinct from
      (case when tpl.data->>'kind' = 'shopify' then 's:' || (regexp_match(tpl.data->>'variantId', '(\d+)$'))[1] || 'x' || coalesce(tpl.data->>'units', '1')
            else 'm:' || coalesce(tpl.data->>'manualCost', '') end))))
  insert into jt.docs (collection, id, data)
  select 'amzmap', jt.amz_docid(t.sku),
    (t.tpl - 'via' - 'fromSku') || jsonb_build_object('sku', t.sku, 'asin', t.asin, 'title', coalesce(t.cur->>'title', t.title, t.tpl->>'title'),
      'updatedAt', to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'via', 'asin', 'fromSku', t.tpl->>'sku')
  from tgt t
  on conflict (collection, id) do update set data = excluded.data, updated_at = now();
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;
revoke all on function jt.fill_asin_mappings(text) from public;

-- Keep it automatic: a mapping saved anywhere (dashboard, Claude) is copied to its ASIN's other SKUs; a new listings /
-- FBA / AWD report fills SKUs it brings in for ASINs that are already mapped.
create or replace function jt.trg_asin_fill() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if pg_trigger_depth() > 1 then return null; end if;
  if new.collection = 'amzmap' then
    if coalesce(new.data->>'via', '') <> 'asin' then perform jt.fill_asin_mappings(new.data->>'sku'); end if;
  elsif new.collection in ('amzlistings', 'fbainv', 'awdinv', 'prepseed') then
    perform jt.fill_asin_mappings(null);
  end if;
  return null;
end $$;
drop trigger if exists docs_asin_fill on jt.docs;
create trigger docs_asin_fill after insert or update on jt.docs
  for each row when (new.collection in ('amzmap', 'amzlistings', 'fbainv', 'awdinv', 'prepseed'))
  execute function jt.trg_asin_fill();

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.v_amz_sku_asin to jt_reader; end if;
end $$;
