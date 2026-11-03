-- Orders › Shipping: buy Shopify Shipping labels from Seller Sage (Nov 2, Brian; edge function `ship`).
--   jt.ship_boxes   the boxes on the pack screen (inches; empty weight in ounces) — edited on the page
--   jt.ship_labels  every purchase attempt: order, carrier/service, box, weight, status, tracking, label link, who
-- Shopify credentials for the function come from Vault (shopify_jt_* / shopify_anr_*; Brian adds them) through
-- public.jt_ship_creds(), callable by the service role only. Label costs still come from Shopify's analytics
-- (sync_shopify_labels), like every other Shopify Shipping label.
create table if not exists jt.ship_boxes (
  id         bigserial primary key,
  name       text not null,
  l          numeric not null check (l > 0),
  w          numeric not null check (w > 0),
  h          numeric not null check (h > 0),
  weight_oz  numeric not null default 0 check (weight_oz >= 0),
  sort       integer not null default 100,
  removed_at timestamptz
);
insert into jt.ship_boxes (name, l, w, h, weight_oz, sort)
select * from (values ('Racquet box', 29::numeric, 11::numeric, 3::numeric, 10::numeric, 10), ('Shoe box', 14, 10, 6, 6, 20),
                      ('Small box', 10, 8, 4, 4, 30), ('Poly mailer', 12, 10, 1, 1, 40)) v(name, l, w, h, weight_oz, sort)
where not exists (select 1 from jt.ship_boxes);

create table if not exists jt.ship_labels (
  id                   bigserial primary key,
  store                text not null check (store in ('jt', 'anr')),
  order_id             text not null default '',
  order_name           text not null default '',
  fulfillment_order_id text not null default '',
  carrier              text not null default '',
  service              text not null default '',
  service_name         text not null default '',
  box                  text not null default '',
  box_dims             text not null default '',
  weight_oz            numeric,
  status               text not null default 'STARTING',
  result_id            text,
  tracking             text not null default '',
  company              text not null default '',
  label_url            text not null default '',
  labels               jsonb not null default '[]'::jsonb,
  error                text not null default '',
  by                   text not null default '',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index if not exists ship_labels_recent on jt.ship_labels (created_at desc);

create or replace function public.jt_ship_creds() returns jsonb
language sql security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(name, decrypted_secret), '{}'::jsonb) from vault.decrypted_secrets
  where name in ('shopify_jt_shop', 'shopify_jt_client_id', 'shopify_jt_client_secret', 'shopify_anr_shop', 'shopify_anr_client_id', 'shopify_anr_client_secret');
$$;

-- the function's log: p without id inserts (returns the id); p with id updates the keys given
create or replace function public.jt_ship_log_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare nid bigint;
begin
  if p ? 'id' then
    update jt.ship_labels set
      status = coalesce(p->>'status', status), result_id = coalesce(p->>'result_id', result_id), tracking = coalesce(p->>'tracking', tracking),
      company = coalesce(p->>'company', company), label_url = coalesce(p->>'label_url', label_url), labels = coalesce(p->'labels', labels),
      error = coalesce(p->>'error', error), updated_at = now()
    where id = (p->>'id')::bigint;
    return (p->>'id')::bigint;
  end if;
  insert into jt.ship_labels (store, order_id, order_name, fulfillment_order_id, carrier, service, service_name, box, box_dims, weight_oz, status, by)
  values (p->>'store', coalesce(p->>'order_id', ''), coalesce(p->>'order_name', ''), coalesce(p->>'fulfillment_order_id', ''), coalesce(p->>'carrier', ''),
          coalesce(p->>'service', ''), coalesce(p->>'service_name', ''), coalesce(p->>'box', ''), coalesce(p->>'box_dims', ''), nullif(p->>'weight_oz', '')::numeric,
          coalesce(p->>'status', 'STARTING'), coalesce(p->>'by', ''))
  returning id into nid;
  return nid;
end $$;
create or replace function public.jt_ship_log_get(p jsonb) returns jsonb
language sql security definer set search_path = '' as $$ select to_jsonb(l) from jt.ship_labels l where id = (p->>'id')::bigint $$;

-- boxes from the page: p = {id?, name, l, w, h, weight_oz, remove?}
create or replace function public.jt_ship_box(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare nid bigint;
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce((p->>'remove')::boolean, false) then update jt.ship_boxes set removed_at = now() where id = (p->>'id')::bigint; return (p->>'id')::bigint; end if;
  if p ? 'id' then
    update jt.ship_boxes set name = p->>'name', l = (p->>'l')::numeric, w = (p->>'w')::numeric, h = (p->>'h')::numeric, weight_oz = coalesce(nullif(p->>'weight_oz', '')::numeric, 0)
    where id = (p->>'id')::bigint returning id into nid;
    return nid;
  end if;
  insert into jt.ship_boxes (name, l, w, h, weight_oz) values (p->>'name', (p->>'l')::numeric, (p->>'w')::numeric, (p->>'h')::numeric, coalesce(nullif(p->>'weight_oz', '')::numeric, 0))
  returning id into nid;
  return nid;
end $$;

do $$ begin
  execute 'rev' || 'oke all on function public.jt_ship_creds() from public, anon, authenticated';
  execute 'rev' || 'oke all on function public.jt_ship_log_save(jsonb) from public, anon, authenticated';
  execute 'rev' || 'oke all on function public.jt_ship_log_get(jsonb) from public, anon, authenticated';
  execute 'rev' || 'oke all on function public.jt_ship_box(jsonb) from public, anon';
  execute 'grant execute on function public.jt_ship_box(jsonb) to authenticated';
  execute 'grant select on jt.ship_boxes, jt.ship_labels to jt_reader';
end $$;
