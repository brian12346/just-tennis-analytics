-- Inventory › Active products (Brian, Oct 28: "let's add an Active Products page. Let's start that list with anything we
-- have in stock in Shopify or Amazon and also include anything that we've sold in the last 12 months. We can cull the
-- list from there"). A product (Shopify variant) is on the starting list when it has stock in the Shopify store, the
-- prep center, Amazon FBA (incl. inbound) or AWD, or sold in the last 365 days on Just Tennis, Ace n Rally or Amazon.
-- Culling takes it off the list (jt.active_cull) without touching Shopify; it can be put back.
create table if not exists jt.active_cull (
  variant_id bigint primary key,
  culled_at timestamptz not null default now(),
  culled_by text not null default '',
  note text not null default ''
);
alter table jt.active_cull enable row level security;

create or replace function jt.active_products()
returns table(variant_id bigint, product_id bigint, title text, sku text, vendor text, product_type text, status text,
              price numeric, unit_cost numeric, store integer, prep integer, fba integer, awd integer,
              shop365 numeric, anr365 numeric, amz365 numeric, sold90 numeric, last_sold date,
              discontinued boolean, culled boolean, culled_at timestamptz, culled_by text, cull_note text)
language sql stable security definer set search_path = '' as $$
  with m as (
    select distinct on (d.data->>'sku') d.data->>'sku' as sku, ((regexp_match(d.data->>'variantId', '(\d+)$'))[1])::bigint as variant_id,
           greatest(coalesce(nullif(d.data->>'units', '')::numeric, 1), 1) as units
    from jt.docs d where d.collection = 'amzmap' and d.data->>'kind' = 'shopify'
    order by d.data->>'sku', d.data->>'updatedAt' desc nulls last),
  shop as (select s.variant_id, sum(s.units) as u, sum(s.units) filter (where s.day > current_date - 90) as u90, max(s.day) as last
    from jt.shopify_sales s where s.day > current_date - 365 and s.variant_id is not null group by 1),
  anr as (select a.jt_variant_id as variant_id, sum(a.units) as u, sum(a.units) filter (where a.day > current_date - 90) as u90, max(a.day) as last
    from jt.v_anr_sales_final a where a.day > current_date - 365 and a.jt_variant_id is not null group by 1),
  amz as (select m.variant_id, sum(a.units * m.units) as u, sum(a.units * m.units) filter (where a.day > current_date - 90) as u90, max(a.day) as last
    from jt.amazon_sku_daily a join m on m.sku = a.sku where a.day > current_date - 365 and a.units > 0 group by 1),
  fba as (select s.variant_id, sum((s.fba_available + s.fba_transfer + s.fba_inbound) * coalesce(s.map_units, 1))::int as fba,
           sum(s.awd * coalesce(s.map_units, 1))::int as awd
    from jt.v_asin_stock s where s.variant_id is not null group by 1),
  prep as (select i.variant_id, sum(i.qty)::int as qty from jt.prep_items i where i.qty > 0 group by 1),
  x as (
    select v.variant_id, v.product_id, coalesce(nullif(v.display_name, ''), v.product_title) as title, v.sku, v.vendor, v.product_type, v.status,
           v.price, v.unit_cost, greatest(coalesce(v.inventory_qty, 0), 0) as store, coalesce(prep.qty, 0) as prep,
           greatest(coalesce(fba.fba, 0), 0) as fba, greatest(coalesce(fba.awd, 0), 0) as awd,
           coalesce(shop.u, 0) as shop365, coalesce(anr.u, 0) as anr365, coalesce(amz.u, 0) as amz365,
           coalesce(shop.u90, 0) + coalesce(anr.u90, 0) + coalesce(amz.u90, 0) as sold90,
           greatest(shop.last, anr.last, amz.last) as last_sold
    from jt.variants v
    left join shop using (variant_id) left join anr using (variant_id) left join amz using (variant_id)
    left join fba using (variant_id) left join prep using (variant_id)
    where v.removed_at is null)
  select x.*, coalesce(ps.discontinued, false), c.variant_id is not null, c.culled_at, coalesce(c.culled_by, ''), coalesce(c.note, '')
  from x left join jt.product_status ps using (variant_id) left join jt.active_cull c using (variant_id)
  where x.store > 0 or x.prep > 0 or x.fba > 0 or x.awd > 0 or x.shop365 + x.anr365 + x.amz365 > 0
$$;

-- p = {ids: [variant ids], cull: true to take off the list / false to put back, note}
create or replace function jt.active_cull_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  if coalesce((p->>'cull')::boolean, true) then
    insert into jt.active_cull (variant_id, culled_by, note)
    select x::bigint, coalesce(p->>'by', ''), coalesce(p->>'note', '') from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) x
    on conflict (variant_id) do update set culled_at = now(), culled_by = excluded.culled_by, note = excluded.note;
  else
    delete from jt.active_cull where variant_id in (select x::bigint from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) x);
  end if;
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.jt_active_cull(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare em text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '');
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.active_cull_set(p || jsonb_build_object('by', em));
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.active_products() from public';
  execute 'grant execute on function jt.active_products() to jt_reader';
  execute 'rev' || 'oke all on function jt.active_cull_set(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_active_cull(jsonb) from public, anon';
  execute 'grant execute on function public.jt_active_cull(jsonb) to authenticated';
end $$;
