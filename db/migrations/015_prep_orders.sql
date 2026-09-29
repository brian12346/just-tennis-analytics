-- New Inventory: orders coming in from vendors, tracked at the order level through
--   draft -> ordered -> invoice -> packing_slip -> received -> shipped
-- Each order has product lines. Receiving adds the units to the prep center (and can be done in parts); "shipped"
-- means the received stock went back out, normally through an Amazon Outgoing shipment made from the order
-- (jt.prep_shipments.order_id): when that shipment is marked shipped, the order is too. An order can be linked to a
-- vendor invoice on the Invoices tab (jt.invoices).

create table if not exists jt.prep_orders (
  id           bigserial primary key,
  vendor       text not null default '',
  po_no        text not null default '',
  status       text not null default 'draft' check (status in ('draft', 'ordered', 'invoice', 'packing_slip', 'received', 'shipped')),
  invoice_id   bigint references jt.invoices (id) on delete set null,
  expected_on  date,                                  -- when the vendor said it would arrive
  note         text not null default '',
  short_ok     boolean not null default false,        -- received less than ordered, and that's accepted (closed short)
  stage_at     jsonb not null default '{}'::jsonb,    -- status -> when it got there
  created_at   timestamptz not null default now(),
  created_by   text not null default '',
  updated_at   timestamptz not null default now()
);
create index if not exists prep_orders_status_idx on jt.prep_orders (status, updated_at desc);

create table if not exists jt.prep_order_lines (
  order_id      bigint not null references jt.prep_orders (id) on delete cascade,
  variant_id    bigint not null,
  amazon_sku    text not null default '',             -- Amazon listing the stock is for ('' = any)
  qty_ordered   integer not null check (qty_ordered >= 0),
  qty_received  integer not null default 0 check (qty_received >= 0),
  unit_cost     numeric(12,4),                        -- from the invoice / typed in (null = use the Shopify cost)
  primary key (order_id, variant_id, amazon_sku)
);

-- receiving is a stock move of its own; an outgoing shipment can come from an order
alter table jt.prep_moves drop constraint if exists prep_moves_kind_check;
alter table jt.prep_moves add constraint prep_moves_kind_check check (kind in ('seed', 'adjust', 'ship', 'receive'));
alter table jt.prep_moves add column if not exists order_id bigint;
alter table jt.prep_shipments add column if not exists order_id bigint;

-- Create or update an order. p = {"id", "vendor", "po_no", "invoice_id", "expected_on", "note", "short_ok", "by",
--   "lines": [{"variant_id", "amazon_sku", "qty", "unit_cost"}]}. Lines replace the old ones, only before receiving;
-- after that only the PO #, invoice, expected date, note and "closed short" can change. Returns the order id.
create or replace function jt.prep_order_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare ord bigint := nullif(p->>'id', '')::bigint; st text;
begin
  if ord is null then
    insert into jt.prep_orders (vendor, po_no, created_by, stage_at) values (coalesce(p->>'vendor', ''), coalesce(p->>'po_no', ''), coalesce(p->>'by', ''),
      jsonb_build_object('draft', now())) returning id into ord;
    st := 'draft';
  else
    select status into st from jt.prep_orders where id = ord for update;
    if st is null then raise exception 'order % not found', ord; end if;
  end if;
  update jt.prep_orders set
    vendor = case when st in ('received', 'shipped') then vendor else coalesce(p->>'vendor', vendor) end,
    po_no = coalesce(p->>'po_no', po_no),
    invoice_id = case when p ? 'invoice_id' then nullif(p->>'invoice_id', '')::bigint else invoice_id end,
    expected_on = case when p ? 'expected_on' then nullif(p->>'expected_on', '')::date else expected_on end,
    note = coalesce(p->>'note', note),
    short_ok = coalesce((p->>'short_ok')::boolean, short_ok),
    updated_at = now()
  where id = ord;
  if p ? 'lines' and st not in ('received', 'shipped') then
    delete from jt.prep_order_lines where order_id = ord;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, qty_ordered, unit_cost)
    select ord, (x->>'variant_id')::bigint, coalesce(x->>'amazon_sku', ''), sum(coalesce((x->>'qty')::integer, 0)), max(nullif(x->>'unit_cost', '')::numeric)
    from jsonb_array_elements(p->'lines') x where coalesce((x->>'qty')::integer, 0) > 0
    group by 2, 3;
  end if;
  return ord;
end $$;
revoke all on function jt.prep_order_save(jsonb) from public;

-- Move an order between draft / ordered / invoice / packing_slip (any direction, before it's received), or mark a
-- received order shipped (no stock change: the stock went out through an Amazon Outgoing shipment, or elsewhere).
-- p = {"id", "status", "by"}. Receiving goes through jt.prep_order_receive.
create or replace function jt.prep_order_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; want text := p->>'status'; st text;
begin
  select status into st from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
  if want in ('draft', 'ordered', 'invoice', 'packing_slip') then
    if st in ('received', 'shipped') then raise exception 'this order has been received; its stock is in the prep center'; end if;
  elsif want = 'shipped' then
    if st <> 'received' then raise exception 'only a received order can be marked shipped'; end if;
  elsif want = 'received' then raise exception 'use receive to take an order in';
  else raise exception 'unknown status %', want; end if;
  update jt.prep_orders set status = want, stage_at = stage_at || jsonb_build_object(want, now()), updated_at = now() where id = ord;
  return want;
end $$;
revoke all on function jt.prep_order_status(jsonb) from public;

-- Receive units into the prep center. p = {"id", "by", "lines": [{"variant_id", "amazon_sku", "qty"}]} where qty is
-- what arrived now (added to anything received before). Lines not on the order are added to it (ordered 0).
-- The order becomes (or stays) received. Returns the number of units received.
create or replace function jt.prep_order_receive(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; st text; x jsonb; q integer; vid bigint; sku text; n integer := 0; after integer; ref text;
begin
  select status, coalesce(nullif(po_no, ''), vendor || ' order ' || id) into st, ref from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
  if st = 'shipped' then raise exception 'this order is already shipped'; end if;
  for x in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    q := coalesce((x->>'qty')::integer, 0); vid := (x->>'variant_id')::bigint; sku := coalesce(x->>'amazon_sku', '');
    if q < 0 then raise exception 'received quantities must be 0 or more'; end if;
    if q = 0 then continue; end if;
    if not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', vid; end if;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, qty_ordered, qty_received) values (ord, vid, sku, 0, q)
      on conflict (order_id, variant_id, amazon_sku) do update set qty_received = jt.prep_order_lines.qty_received + excluded.qty_received;
    insert into jt.prep_items (variant_id, amazon_sku, qty) values (vid, sku, q)
      on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now()
      returning qty into after;
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
    values ('receive', vid, sku, q, after, ref, coalesce(p->>'note', ''), coalesce(p->>'by', ''), ord);
    n := n + q;
  end loop;
  if n = 0 then raise exception 'nothing to receive'; end if;
  update jt.prep_orders set status = 'received', stage_at = case when st = 'received' then stage_at else stage_at || jsonb_build_object('received', now()) end,
    updated_at = now() where id = ord;
  return n;
end $$;
revoke all on function jt.prep_order_receive(jsonb) from public;

-- Delete an order that hasn't been received (received stock stays; fix it with a count instead).
create or replace function jt.prep_order_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select status into st from jt.prep_orders where id = (p->>'id')::bigint for update;
  if st is null then return false; end if;
  if st in ('received', 'shipped') then raise exception 'a received order can''t be deleted'; end if;
  delete from jt.prep_orders where id = (p->>'id')::bigint;
  return true;
end $$;
revoke all on function jt.prep_order_delete(jsonb) from public;

-- Outgoing shipments remember the order they were made from ...
create or replace function jt.prep_shipment_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare sid bigint := nullif(p->>'id', '')::bigint; st text; d text := upper(coalesce(nullif(p->>'dest', ''), 'FBA'));
begin
  if d not in ('FBA', 'AWD') then raise exception 'destination must be FBA or AWD'; end if;
  if sid is null then
    insert into jt.prep_shipments (name, dest, note, created_by, order_id)
    values (coalesce(p->>'name', ''), d, coalesce(p->>'note', ''), coalesce(p->>'by', ''), nullif(p->>'order_id', '')::bigint) returning id into sid;
  else
    select status into st from jt.prep_shipments where id = sid for update;
    if st is null then raise exception 'shipment % not found', sid; end if;
    if st = 'shipped' then raise exception 'shipment % is already shipped and can''t be changed', sid; end if;
    update jt.prep_shipments set name = coalesce(p->>'name', name), dest = d, note = coalesce(p->>'note', note),
      order_id = case when p ? 'order_id' then nullif(p->>'order_id', '')::bigint else order_id end, updated_at = now() where id = sid;
  end if;
  if p ? 'lines' then
    delete from jt.prep_shipment_lines where shipment_id = sid;
    insert into jt.prep_shipment_lines (shipment_id, variant_id, amazon_sku, qty)
    select sid, (x->>'variant_id')::bigint, coalesce(x->>'amazon_sku', ''), sum((x->>'qty')::integer)
    from jsonb_array_elements(p->'lines') x where coalesce((x->>'qty')::integer, 0) > 0
    group by 2, 3;
  end if;
  return sid;
end $$;

-- ... and marking that shipment shipped marks its (received) order shipped too.
create or replace function jt.prep_shipment_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p->>'id')::bigint; want text := p->>'status'; s record; lines jsonb;
begin
  if want not in ('open', 'started', 'shipped') then raise exception 'unknown status %', want; end if;
  select * into s from jt.prep_shipments where id = sid for update;
  if s.id is null then raise exception 'shipment % not found', sid; end if;
  if s.status = 'shipped' then raise exception 'shipment % is already shipped', sid; end if;
  if want = 'shipped' then
    select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'amazon_sku', amazon_sku, 'qty', qty)) into lines
    from jt.prep_shipment_lines where shipment_id = sid;
    if lines is null then raise exception 'shipment % has no products', sid; end if;
    perform jt.prep_ship(jsonb_build_object('shipment', coalesce(nullif(s.name, ''), 'Shipment ' || sid), 'dest', s.dest,
      'note', s.note, 'by', coalesce(p->>'by', ''), 'lines', lines));
    update jt.prep_moves set shipment_id = sid where kind = 'ship' and shipment_id is null and at = now();
    update jt.prep_shipments set status = 'shipped', shipped_at = now(), shipped_by = coalesce(p->>'by', ''),
      started_at = coalesce(started_at, now()), updated_at = now() where id = sid;
    if s.order_id is not null then
      update jt.prep_orders set status = 'shipped', stage_at = stage_at || jsonb_build_object('shipped', now()), updated_at = now()
      where id = s.order_id and status = 'received';
    end if;
  else
    update jt.prep_shipments set status = want, started_at = case when want = 'started' then coalesce(started_at, now()) else started_at end,
      updated_at = now() where id = sid;
  end if;
  return want;
end $$;

-- Web wrappers (app users; "by" = signed-in email)
create or replace function public.jt_prep_order_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_order_save(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_prep_order_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_order_status(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_prep_order_receive(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_order_receive(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_prep_order_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_order_delete(p);
end $$;
revoke all on function public.jt_prep_order_save(jsonb), public.jt_prep_order_status(jsonb), public.jt_prep_order_receive(jsonb), public.jt_prep_order_delete(jsonb) from public, anon;
grant execute on function public.jt_prep_order_save(jsonb), public.jt_prep_order_status(jsonb), public.jt_prep_order_receive(jsonb), public.jt_prep_order_delete(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.prep_orders, jt.prep_order_lines to jt_reader;
  end if;
end $$;
