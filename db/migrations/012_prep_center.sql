-- Prep center: the part of the physical warehouse set aside to send to Amazon (the rest is Shopify inventory).
-- Stock is held per Shopify variant, optionally earmarked for one Amazon listing (seller SKU). Every change is a
-- row in jt.prep_moves: a count adjustment, a shipment to Amazon (FBA or AWD), or the starting seed.

create table if not exists jt.prep_items (
  id          bigserial primary key,
  variant_id  bigint not null,                 -- jt.variants.variant_id
  amazon_sku  text not null default '',        -- Amazon seller SKU it's prepped for; '' = not assigned
  qty         integer not null default 0 check (qty >= 0),
  note        text not null default '',
  updated_at  timestamptz not null default now(),
  unique (variant_id, amazon_sku)
);

create table if not exists jt.prep_moves (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  kind        text not null check (kind in ('seed', 'adjust', 'ship')),
  variant_id  bigint not null,
  amazon_sku  text not null default '',
  qty_change  integer not null,
  qty_after   integer not null,
  shipment    text not null default '',        -- Amazon shipment ID / name (ship)
  dest        text not null default '',        -- 'FBA' | 'AWD' (ship)
  note        text not null default '',
  by_user     text not null default ''
);
create index if not exists prep_moves_at_idx on jt.prep_moves (at desc);

-- Set counts. p = {"by": "...", "lines": [{"variant_id": 1, "amazon_sku": "", "qty": 12, "note": "cycle count"}]}
-- qty is the new on-hand count (not a delta). Returns the number of lines that changed.
create or replace function jt.prep_adjust(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare x jsonb; n integer := 0; cur integer; want integer; sku text;
begin
  for x in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    want := (x->>'qty')::integer; sku := coalesce(x->>'amazon_sku', '');
    if want is null or want < 0 then raise exception 'count must be 0 or more'; end if;
    if not exists (select 1 from jt.variants v where v.variant_id = (x->>'variant_id')::bigint) then
      raise exception 'unknown Shopify variant %', x->>'variant_id';
    end if;
    select i.qty into cur from jt.prep_items i where i.variant_id = (x->>'variant_id')::bigint and i.amazon_sku = sku for update;
    if cur is not distinct from want then continue; end if;
    insert into jt.prep_items (variant_id, amazon_sku, qty, note)
    values ((x->>'variant_id')::bigint, sku, want, coalesce(x->>'note', ''))
    on conflict (variant_id, amazon_sku) do update set qty = excluded.qty, note = excluded.note, updated_at = now();
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user)
    values ('adjust', (x->>'variant_id')::bigint, sku, want - coalesce(cur, 0), want, coalesce(x->>'note', ''), coalesce(p->>'by', ''));
    n := n + 1;
  end loop;
  delete from jt.prep_items where qty = 0;
  return n;
end $$;
revoke all on function jt.prep_adjust(jsonb) from public;

-- Ship to Amazon. p = {"by": "...", "shipment": "FBA17XYZ", "dest": "FBA", "note": "",
--                      "lines": [{"variant_id": 1, "amazon_sku": "", "qty": 24}]}
-- Takes the units out of the prep center; fails (and changes nothing) if a line has fewer units than asked.
create or replace function jt.prep_ship(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare x jsonb; n integer := 0; cur integer; q integer; sku text; d text := upper(coalesce(p->>'dest', 'FBA'));
begin
  if d not in ('FBA', 'AWD') then raise exception 'destination must be FBA or AWD'; end if;
  for x in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    q := (x->>'qty')::integer; sku := coalesce(x->>'amazon_sku', '');
    if q is null or q <= 0 then continue; end if;
    select i.qty into cur from jt.prep_items i where i.variant_id = (x->>'variant_id')::bigint and i.amazon_sku = sku for update;
    if coalesce(cur, 0) < q then
      raise exception 'only % in the prep center for variant % %, can''t ship %', coalesce(cur, 0), x->>'variant_id', sku, q;
    end if;
    update jt.prep_items set qty = qty - q, updated_at = now() where variant_id = (x->>'variant_id')::bigint and amazon_sku = sku;
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, dest, note, by_user)
    values ('ship', (x->>'variant_id')::bigint, sku, -q, cur - q, coalesce(p->>'shipment', ''), d, coalesce(p->>'note', ''), coalesce(p->>'by', ''));
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'nothing to ship'; end if;
  delete from jt.prep_items where qty = 0;
  return n;
end $$;
revoke all on function jt.prep_ship(jsonb) from public;

-- Starting inventory: replaces everything in the prep center. p = {"by": "...", "lines": [{variant_id, amazon_sku, qty}]}
create or replace function jt.prep_seed(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from jt.prep_items;
  insert into jt.prep_items (variant_id, amazon_sku, qty)
  select (x->>'variant_id')::bigint, coalesce(x->>'amazon_sku', ''), sum((x->>'qty')::integer)
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) x
  where (x->>'qty')::integer > 0
  group by 1, 2;
  get diagnostics n = row_count;
  insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user)
  select 'seed', variant_id, amazon_sku, qty, qty, 'starting inventory', coalesce(p->>'by', '') from jt.prep_items;
  return n;
end $$;
revoke all on function jt.prep_seed(jsonb) from public;

-- Web wrappers: app users only; "by" is the signed-in email.
create or replace function public.jt_prep_adjust(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_adjust(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_adjust(jsonb) from public, anon;
grant execute on function public.jt_prep_adjust(jsonb) to authenticated;

create or replace function public.jt_prep_ship(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_ship(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_ship(jsonb) from public, anon;
grant execute on function public.jt_prep_ship(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.prep_items, jt.prep_moves to jt_reader;
  end if;
end $$;
