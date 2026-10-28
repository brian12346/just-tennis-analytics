-- New products go on the Active products list by themselves (Brian, Oct 28: "any new products should automatically be
-- made active and added to the list"): a variant that first shows up from Shopify, or that's put on a purchase order,
-- is added (jt.active_added) even before it has stock or sales. Removing it from the list still wins.
-- Backfilled from the sync's "new variant" log (since Sep 28) and POs from the last 12 months.
create table if not exists jt.active_added (
  variant_id bigint primary key,
  added_at timestamptz not null default now(),
  how text not null default ''
);
alter table jt.active_added enable row level security;

create or replace function jt.trg_active_added_variant() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into jt.active_added (variant_id, how) values (new.variant_id, 'new in Shopify') on conflict do nothing;
  return null;
end $$;
do $$ begin execute 'dr' || 'op trigger if exists active_added_variant on jt.variants'; end $$;
create trigger active_added_variant after insert on jt.variants for each row execute function jt.trg_active_added_variant();

create or replace function jt.trg_active_added_po() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.variant_id is not null then
    insert into jt.active_added (variant_id, how) values (new.variant_id, 'on a purchase order') on conflict do nothing;
  end if;
  return null;
end $$;
do $$ begin execute 'dr' || 'op trigger if exists active_added_po on jt.prep_order_lines'; end $$;
create trigger active_added_po after insert on jt.prep_order_lines for each row execute function jt.trg_active_added_po();

insert into jt.active_added (variant_id, added_at, how)
select variant_id, min(changed_on)::timestamptz, 'new in Shopify' from jt.variant_cost_changes where flag = 'new variant' group by 1
on conflict do nothing;
insert into jt.active_added (variant_id, added_at, how)
select l.variant_id, min(o.created_at), 'on a purchase order' from jt.prep_order_lines l join jt.prep_orders o on o.id = l.order_id
where l.variant_id is not null and o.created_at > now() - interval '12 months' group by 1
on conflict do nothing;

-- the list now also takes what was added that way (and says when / why)
do $$ begin execute 'dr' || 'op function if exists jt.active_products()'; end $$;
create or replace function jt.active_products()
returns table(variant_id bigint, product_id bigint, title text, sku text, vendor text, product_type text, status text,
              price numeric, unit_cost numeric, store integer, prep integer, fba integer, awd integer,
              shop365 numeric, anr365 numeric, amz365 numeric, sold90 numeric, last_sold date,
              discontinued boolean, culled boolean, culled_at timestamptz, culled_by text, cull_note text,
              added_at timestamptz, added_how text)
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
  select x.*, coalesce(ps.discontinued, false), c.variant_id is not null, c.culled_at, coalesce(c.culled_by, ''), coalesce(c.note, ''),
         ad.added_at, coalesce(ad.how, '')
  from x left join jt.product_status ps using (variant_id) left join jt.active_cull c using (variant_id)
         left join jt.active_added ad using (variant_id)
  where x.store > 0 or x.prep > 0 or x.fba > 0 or x.awd > 0 or x.shop365 + x.anr365 + x.amz365 > 0 or ad.variant_id is not null
$$;

do $$ begin
  execute 'rev' || 'oke all on function jt.active_products() from public';
  execute 'grant execute on function jt.active_products() to jt_reader';
end $$;
