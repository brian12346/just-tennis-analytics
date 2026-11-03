-- Out of stock › To order and Archive (Nov 3, Brian: "add another area below called 'To Order' … if we are out and
-- want to reorder, then let's add the item to that list. if it's the last one and we don't want to carry it anymore,
-- then we should be able to archive the product").
--   To order is the existing On The List (jt.prep_list, dest 'shopify', source 'oos'): jt_prep_list_add puts a product
--   on it, jt_prep_list_to_po puts it on its vendor's draft PO, receiving that PO closes it.
--   Archive: jt.product_archives — a request to set the Shopify product to Archived, applied by job fbm-inventory
--   (apply_product_archives; needs the app's write_products scope). Only when none of the product's variants has stock.
create table if not exists jt.product_archives (
  id          bigserial primary key,
  product_id  bigint not null,
  variant_id  bigint,
  status      text not null default 'pending' check (status in ('pending', 'done', 'failed')),
  error       text not null default '',
  by          text not null default '',
  created_at  timestamptz not null default now(),
  applied_at  timestamptz
);
create index if not exists product_archives_product on jt.product_archives (product_id, created_at desc);

-- p = {variant_id, by}
create or replace function jt.product_archive(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; pid bigint; ttl text; left_units integer; left_n integer; rid bigint;
begin
  select product_id, product_title into pid, ttl from jt.variants where variant_id = vid;
  if pid is null then raise exception 'product % not found', vid; end if;
  select coalesce(sum(greatest(jt.shopify_qty_now(variant_id), 0)), 0), count(*) filter (where jt.shopify_qty_now(variant_id) > 0)
    into left_units, left_n from jt.variants where product_id = pid and removed_at is null;
  if left_units > 0 then
    raise exception '% still has % unit% in stock in % other variant% — archiving takes the whole product off the store',
      ttl, left_units, case when left_units = 1 then '' else 's' end, left_n, case when left_n = 1 then '' else 's' end;
  end if;
  select id into rid from jt.product_archives where product_id = pid and status = 'pending';
  if rid is not null then return rid; end if;
  insert into jt.product_archives (product_id, variant_id, by) values (pid, vid, coalesce(p->>'by', '')) returning id into rid;
  -- off the To order list too
  perform jt.prep_list_remove(jsonb_build_object('id', i.id)) from jt.prep_list i
    where i.closed_at is null and i.variant_id in (select variant_id from jt.variants where product_id = pid);
  if to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;
  end if;
  return rid;
end $$;

create or replace function public.jt_product_archive(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.product_archive(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '')));
end $$;

do $$ begin
  execute 'grant select on jt.product_archives to jt_reader';
  execute 'grant select on jt.prep_list to jt_reader';
  execute 'rev' || 'oke all on function jt.product_archive(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_product_archive(jsonb) from public, anon';
  execute 'grant execute on function public.jt_product_archive(jsonb) to authenticated';
end $$;
