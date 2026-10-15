-- Packing photos (Brian, Oct 15): in the warehouse the packer opens Seller Sage on the iPhone, scans the packing slip
-- or shipping label, takes photos, and each photo is saved to that order. Orders: Just Tennis and Ace n Rally
-- (Shopify) and Amazon FBM. Photos are viewed in Seller Sage, and each Shopify order gets a link to them (metafield
-- seller_sage.packing_photos, set by the sync job).
--
-- Files live in the private Storage bucket "order-photos" (<store>/<order>/<time>-<id>.jpg); only app users can read or
-- add them. jt.order_photos keeps one row per photo. A scan that doesn't match an order yet (e.g. a brand-new order
-- before the next sync) is still saved under the scanned code and matched to its order later (jt.order_photos_match).

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('order-photos', 'order-photos', false, 15728640, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create or replace function public.jt_storage_ok() returns boolean
language sql stable security definer set search_path = '' as $$ select jt.is_app_user() $$;
grant execute on function public.jt_storage_ok() to authenticated;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'order photos: app users read') then
    create policy "order photos: app users read" on storage.objects for select to authenticated
      using (bucket_id = 'order-photos' and public.jt_storage_ok());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'order photos: app users add') then
    create policy "order photos: app users add" on storage.objects for insert to authenticated
      with check (bucket_id = 'order-photos' and public.jt_storage_ok());
  end if;
end $$;

create table if not exists jt.order_photos (
  id          bigserial primary key,
  store       text not null default '',             -- justtennis | acenrally | amazon | '' (not matched yet)
  order_id    text,                                 -- Shopify order id / Amazon order id; null until matched
  order_name  text not null default '',             -- #22738 / 111-7424725-5283436
  code        text not null default '',             -- what was scanned or typed
  path        text not null unique,                 -- object path in the order-photos bucket
  bytes       integer,
  width       integer,
  height      integer,
  taken_at    timestamptz not null default now(),
  taken_by    text not null default '',
  hidden_at   timestamptz,                          -- taken out of the order's photos (the file stays)
  hidden_by   text not null default ''
);
create index if not exists order_photos_order on jt.order_photos (store, order_id);
create index if not exists order_photos_taken on jt.order_photos (taken_at desc);

-- the link on each Shopify order (sync job sets the metafield)
create table if not exists jt.order_photo_links (
  store      text not null,
  order_id   text not null,
  status     text not null default 'pending',       -- pending | done | failed
  error      text not null default '',
  linked_at  timestamptz,
  primary key (store, order_id)
);

-- Find orders for a scanned or typed code: an order number (#22738 or 22738), an Amazon order id (with or without
-- dashes), or a tracking number (Shopify fulfillment tracking or a ShipStation label; a USPS barcode's 420+ZIP prefix
-- is allowed). Returns [{store, order_id, name, created, status, items: [{title, sku, qty}], photos}].
create or replace function jt.order_find(q text) returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare t text := upper(regexp_replace(coalesce(q, ''), '\s', '', 'g')); d text; amz text; r jsonb := '[]'::jsonb;
begin
  if length(t) < 3 then return r; end if;
  d := regexp_replace(t, '\D', '', 'g');
  amz := case when t ~ '^\d{3}-\d{7}-\d{7}$' then t when d ~ '^\d{17}$' and t !~ '[A-Z]' then substr(d, 1, 3) || '-' || substr(d, 4, 7) || '-' || substr(d, 11, 7) end;
  with hits as (
    select 'justtennis' st, o.order_id::text oid from jt.shopify_orders o
      where o.name = '#' || ltrim(t, '#')
    union select 'acenrally', o.order_id::text from jt.anr_orders o
      where o.name = '#' || ltrim(t, '#') or (t ~ '^#?\d+$' and o.name = '#ANR' || ltrim(t, '#'))
    union select 'justtennis', k.order_id::text from jt.shopify_order_tracking k
      where length(t) >= 10 and length(k.tracking) >= 8 and (upper(k.tracking) = t or (length(t) > length(k.tracking) + 4 and t like '%' || upper(k.tracking)))
    union select 'acenrally', k.order_id::text from jt.anr_order_tracking k
      where length(t) >= 10 and length(k.tracking) >= 8 and (upper(k.tracking) = t or (length(t) > length(k.tracking) + 4 and t like '%' || upper(k.tracking)))
    union select case when exists (select 1 from jt.anr_orders a where a.order_id = l.order_id) then 'acenrally' else 'justtennis' end, l.order_id::text
      from jt.shipstation_labels l
      where length(t) >= 10 and length(l.tracking) >= 8 and not l.voided and (upper(l.tracking) = t or (length(t) > length(l.tracking) + 4 and t like '%' || upper(l.tracking)))
    union select 'amazon', a.order_id from jt.amazon_order_lines a where amz is not null and a.order_id = amz
  ), x as (
    select h.st, h.oid,
      case h.st when 'justtennis' then (select jsonb_build_object('name', o.name, 'created', o.created_at, 'status', coalesce(o.fulfillment_status, ''), 'cancelled', o.cancelled_at is not null)
                                        from jt.shopify_orders o where o.order_id::text = h.oid)
                when 'acenrally' then (select jsonb_build_object('name', o.name, 'created', o.created_at, 'status', coalesce(o.fulfillment_status, ''), 'cancelled', o.cancelled_at is not null)
                                        from jt.anr_orders o where o.order_id::text = h.oid)
                else (select jsonb_build_object('name', h.oid, 'created', min(a.purchase_at), 'status', max(a.order_status), 'cancelled', bool_and(a.order_status = 'Cancelled'))
                      from jt.amazon_order_lines a where a.order_id = h.oid) end info,
      case h.st when 'justtennis' then (select coalesce(jsonb_agg(jsonb_build_object('title', l.title || coalesce(nullif(' - ' || nullif(l.variant_title, 'Default Title'), ' - '), ''), 'sku', coalesce(l.sku, ''), 'qty', coalesce(l.current_quantity, l.quantity))), '[]')
                                        from jt.shopify_order_lines l where l.order_id::text = h.oid)
                when 'acenrally' then (select coalesce(jsonb_agg(jsonb_build_object('title', l.title || coalesce(nullif(' - ' || nullif(l.variant_title, 'Default Title'), ' - '), ''), 'sku', coalesce(l.sku, ''), 'qty', coalesce(l.current_quantity, l.quantity))), '[]')
                                        from jt.anr_order_lines l where l.order_id::text = h.oid)
                else (select coalesce(jsonb_agg(jsonb_build_object('title', a.product_name, 'sku', a.sku, 'qty', a.quantity)), '[]') from jt.amazon_order_lines a where a.order_id = h.oid) end items,
      (select count(*) from jt.order_photos p where p.store = h.st and p.order_id = h.oid and p.hidden_at is null) photos
    from hits h
  )
  select coalesce(jsonb_agg(jsonb_build_object('store', x.st, 'order_id', x.oid, 'name', x.info->>'name', 'created', x.info->>'created', 'status', x.info->>'status',
           'cancelled', coalesce((x.info->>'cancelled')::boolean, false), 'items', x.items, 'photos', x.photos) order by x.info->>'created' desc), '[]'::jsonb)
    into r from x where x.info is not null;
  return r;
end $$;

-- p = {store, order_id, order_name, code, path, bytes, width, height, by}; returns the photo id
create or replace function jt.order_photo_add(p jsonb) returns bigint
language plpgsql security invoker set search_path = '' as $$
declare pid bigint;
begin
  if coalesce(p->>'path', '') !~ '^[a-z]*/[A-Za-z0-9_.#-]+/[A-Za-z0-9_.-]+$' then raise exception 'bad photo path'; end if;
  insert into jt.order_photos (store, order_id, order_name, code, path, bytes, width, height, taken_by)
  values (coalesce(p->>'store', ''), nullif(p->>'order_id', ''), coalesce(p->>'order_name', ''), coalesce(p->>'code', ''), p->>'path',
          nullif(p->>'bytes', '')::integer, nullif(p->>'width', '')::integer, nullif(p->>'height', '')::integer, coalesce(p->>'by', ''))
  returning id into pid;
  if coalesce(p->>'store', '') in ('justtennis', 'acenrally') and nullif(p->>'order_id', '') is not null then
    insert into jt.order_photo_links (store, order_id) values (p->>'store', p->>'order_id') on conflict do nothing;
  end if;
  return pid;
end $$;

-- take a photo out of the order's photos (or put it back): p = {id, hide, by}
create or replace function jt.order_photo_hide(p jsonb) returns boolean
language plpgsql security invoker set search_path = '' as $$
begin
  update jt.order_photos set hidden_at = case when coalesce((p->>'hide')::boolean, true) then now() end,
                             hidden_by = case when coalesce((p->>'hide')::boolean, true) then coalesce(p->>'by', '') else '' end
  where id = (p->>'id')::bigint;
  return found;
end $$;

-- photos saved under a code that didn't match an order yet: match them now that the order has synced
create or replace function jt.order_photos_match() returns integer
language plpgsql security invoker set search_path = '' as $$
declare r record; f jsonb; n int := 0;
begin
  for r in select distinct code from jt.order_photos where order_id is null and code <> '' and taken_at > now() - interval '30 days' loop
    f := jt.order_find(r.code);
    if jsonb_array_length(f) = 1 then
      update jt.order_photos set store = f->0->>'store', order_id = f->0->>'order_id', order_name = f->0->>'name'
      where order_id is null and code = r.code;
      if f->0->>'store' in ('justtennis', 'acenrally') then
        insert into jt.order_photo_links (store, order_id) values (f->0->>'store', f->0->>'order_id') on conflict do nothing;
      end if;
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- app wrappers (refused unless the signed-in user is an app user)
create or replace function public.jt_order_find(q text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform jt.order_photos_match();
  return jt.order_find(q);
end $$;
create or replace function public.jt_order_photo_add(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.order_photo_add(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_order_photo_hide(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.order_photo_hide(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
grant execute on function public.jt_order_find(text), public.jt_order_photo_add(jsonb), public.jt_order_photo_hide(jsonb) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.order_photos, jt.order_photo_links to jt_reader;
  end if;
end $$;
