-- Finance › Amazon payouts › per-SKU cost check (Brian, Oct 10): A2X's cost per SKU (its COGS export, uploaded on the
-- page) against the cost Seller Sage uses (the Amazon mapping: jt.mv_amz_sku_cost), weighted by the units sold in the
-- settlements A2X posted — which SKUs make Seller Sage's cost of goods differ from A2X's. A file is checked by rebuilding
-- A2X's cost of goods from it (units × A2X cost per settlement) against what A2X actually posted.

create table if not exists fin.a2x_sku_costs (
  sku         text primary key,
  cost        numeric,                           -- null = no cost in A2X
  name        text not null default '',
  batch       bigint not null,                   -- the upload it came from; only the latest upload counts
  uploaded_at timestamptz not null default now(),
  uploaded_by text not null default '',
  file        text not null default ''
);

-- p = {file, rows: [{sku, cost, name}]} -> rows saved (a new upload replaces the last one)
create or replace function public.fin_a2x_costs_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare b bigint := (extract(epoch from clock_timestamp()) * 1000)::bigint; n int;
  who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '');
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into fin.a2x_sku_costs (sku, cost, name, batch, uploaded_at, uploaded_by, file)
  select distinct on (trim(x->>'sku')) trim(x->>'sku'), nullif(regexp_replace(coalesce(x->>'cost', ''), '[$,\s]', '', 'g'), '')::numeric,
         coalesce(x->>'name', ''), b, now(), who, coalesce(p->>'file', '')
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x where coalesce(trim(x->>'sku'), '') <> ''
  on conflict (sku) do update set cost = excluded.cost, name = excluded.name, batch = excluded.batch, uploaded_at = excluded.uploaded_at,
    uploaded_by = excluded.uploaded_by, file = excluded.file;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function public.fin_a2x_costs_save(jsonb) from public;

create or replace view fin.v_a2x_costs as
select * from fin.a2x_sku_costs where batch = (select max(batch) from fin.a2x_sku_costs);

-- per SKU, over the settlements A2X posted: units sold, A2X's cost and Seller Sage's, and what the difference comes to
create or replace view fin.v_amz_sku_check as
with u as (
  select u.sku, sum(u.qty) as units, count(distinct u.settlement_id) as settlements,
         sum(u.qty) filter (where s.market = 'US') as us_units, sum(u.qty) filter (where s.market <> 'US') as intl_units,
         string_agg(distinct u.fulfillment, '/') as fulfillment
  from fin.amz_settlement_units u join fin.amz_settlements s using (settlement_id)
  where cardinality(s.a2x_docs) > 0 and u.qty <> 0
  group by 1)
select u.sku, u.units, u.settlements, u.us_units, u.intl_units, u.fulfillment,
       a.cost as a2x_cost, (a.sku is not null) as in_a2x, a.name as a2x_name,
       m.cost as our_cost, m.map_units, v.display_name as our_name, v.unit_cost as shopify_unit_cost,
       m.cost - a.cost as diff_per_unit,
       u.units * coalesce(m.cost, 0) - u.units * coalesce(a.cost, 0) as impact
from u
left join fin.v_a2x_costs a on a.sku = u.sku
left join jt.mv_amz_sku_cost m on m.sku = u.sku
left join jt.variants v on v.variant_id = m.variant_id;

-- does the uploaded file rebuild what A2X posted? per settlement: units × A2X cost vs A2X's cost of goods entries
create or replace view fin.v_amz_a2x_cost_fit as
select s.settlement_id, s.market, s.start_at, s.end_at,
       (select coalesce(sum(l.amount), 0) from fin.amz_a2x_lines l where l.settlement_id = s.settlement_id and l.kind = 'cogs' and l.amount > 0) as a2x_posted,
       (select coalesce(sum(u.qty * a.cost), 0) from fin.amz_settlement_units u join fin.v_a2x_costs a on a.sku = u.sku where u.settlement_id = s.settlement_id) as from_file,
       (select coalesce(sum(u.qty * m.cost), 0) from fin.amz_settlement_units u join jt.mv_amz_sku_cost m on m.sku = u.sku where u.settlement_id = s.settlement_id) as seller_sage
from fin.amz_settlements s where cardinality(s.a2x_docs) > 0;

grant select on fin.a2x_sku_costs, fin.v_a2x_costs, fin.v_amz_sku_check, fin.v_amz_a2x_cost_fit to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_a2x_costs_save(jsonb) from anon;
    grant execute on function public.fin_a2x_costs_save(jsonb) to authenticated;
  end if;
end $$;
