-- On The List: products marked for re-order, each one either waiting for an order or put on an Incoming Inventory
-- order — the vendor's in-flight draft, or a booking order (a draft marked kind = 'booking' with a place-by date).
-- An item is for the prep center (Amazon) or for the Shopify store (dest). Its progress comes from its order:
-- no order -> needs an order; draft -> on a draft / booking; ordered ... packing slip -> on order; received -> done.
--
-- Order lines now also carry dest: receiving a 'shopify' line records what arrived but doesn't add to the prep center.

alter table jt.prep_orders add column if not exists kind text not null default 'order';
alter table jt.prep_orders drop constraint if exists prep_orders_kind_check;
alter table jt.prep_orders add constraint prep_orders_kind_check check (kind in ('order', 'booking'));
alter table jt.prep_orders add column if not exists place_by date;       -- booking orders: when it has to be placed

alter table jt.prep_order_lines add column if not exists dest text not null default 'prep';
alter table jt.prep_order_lines drop constraint if exists prep_order_lines_dest_check;
alter table jt.prep_order_lines add constraint prep_order_lines_dest_check check (dest in ('prep', 'shopify'));
alter table jt.prep_order_lines drop constraint if exists prep_order_lines_pkey;
alter table jt.prep_order_lines add primary key (order_id, variant_id, amazon_sku, dest);

create table if not exists jt.prep_list (
  id          bigserial primary key,
  variant_id  bigint not null,
  amazon_sku  text not null default '',                 -- Amazon listing it's for ('' = any / not Amazon)
  dest        text not null default 'prep' check (dest in ('prep', 'shopify')),
  qty         integer check (qty is null or qty >= 0),  -- how many to order (null = not decided yet)
  note        text not null default '',
  source      text not null default '',                 -- where it was marked: prep | amazon | inventory | search
  order_id    bigint references jt.prep_orders (id) on delete set null,
  added_at    timestamptz not null default now(),
  added_by    text not null default '',
  closed_at   timestamptz                               -- set when its order is received (null = still on the list)
);
create unique index if not exists prep_list_open_idx on jt.prep_list (variant_id, amazon_sku, dest) where closed_at is null;

-- Mark a product. p = {variant_id, amazon_sku, dest, qty, note, source, by}. Already on the list: qty / note updated.
create or replace function jt.prep_list_add(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare lid bigint; vid bigint := (p->>'variant_id')::bigint; sku text := coalesce(p->>'amazon_sku', ''); d text := coalesce(nullif(p->>'dest', ''), 'prep');
begin
  if not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', vid; end if;
  select id into lid from jt.prep_list where variant_id = vid and amazon_sku = sku and dest = d and closed_at is null for update;
  if lid is null then
    insert into jt.prep_list (variant_id, amazon_sku, dest, qty, note, source, added_by)
    values (vid, sku, d, nullif(p->>'qty', '')::integer, coalesce(p->>'note', ''), coalesce(p->>'source', ''), coalesce(p->>'by', '')) returning id into lid;
  else
    update jt.prep_list set qty = case when p ? 'qty' then nullif(p->>'qty', '')::integer else qty end, note = coalesce(p->>'note', note) where id = lid;
    -- keep a draft order's line in step with the list quantity
    update jt.prep_order_lines l set qty_ordered = coalesce(i.qty, l.qty_ordered)
    from jt.prep_list i join jt.prep_orders o on o.id = i.order_id
    where i.id = lid and o.status = 'draft' and l.order_id = o.id and l.variant_id = i.variant_id and l.amazon_sku = i.amazon_sku and l.dest = i.dest;
  end if;
  return lid;
end $$;
revoke all on function jt.prep_list_add(jsonb) from public;

-- Put list items on an order. p = {ids: [...], order_id} or {ids, new: {vendor, kind, place_by, po_no}}, by.
-- The order must still be a draft. Items move off any other draft they were on. Returns the order id.
create or replace function jt.prep_list_assign(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare ord bigint := nullif(p->>'order_id', '')::bigint; st text; i record; n jsonb := p->'new';
begin
  if ord is null then
    if n is null then raise exception 'pick an order'; end if;
    insert into jt.prep_orders (vendor, po_no, kind, place_by, created_by, stage_at)
    values (coalesce(n->>'vendor', ''), coalesce(n->>'po_no', ''), coalesce(nullif(n->>'kind', ''), 'order'), nullif(n->>'place_by', '')::date,
      coalesce(p->>'by', ''), jsonb_build_object('draft', now())) returning id into ord;
  end if;
  select status into st from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
  if st <> 'draft' then raise exception 'that order has already been placed; list items go on a draft or booking order'; end if;
  for i in select * from jt.prep_list where id in (select (x #>> '{}')::bigint from jsonb_array_elements(coalesce(p->'ids', '[]'::jsonb)) x) and closed_at is null for update loop
    if i.order_id is not null and i.order_id <> ord then
      delete from jt.prep_order_lines l using jt.prep_orders o
      where o.id = i.order_id and o.status = 'draft' and l.order_id = o.id and l.variant_id = i.variant_id and l.amazon_sku = i.amazon_sku and l.dest = i.dest;
    end if;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered)
    values (ord, i.variant_id, i.amazon_sku, i.dest, coalesce(i.qty, 0))
    on conflict (order_id, variant_id, amazon_sku, dest) do update set qty_ordered = greatest(jt.prep_order_lines.qty_ordered, excluded.qty_ordered);
    update jt.prep_list set order_id = ord where id = i.id;
  end loop;
  update jt.prep_orders set updated_at = now() where id = ord;
  return ord;
end $$;
revoke all on function jt.prep_list_assign(jsonb) from public;

-- Take an item off the list (and off its order if that's still a draft). p = {id}
create or replace function jt.prep_list_remove(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare i record;
begin
  select * into i from jt.prep_list where id = (p->>'id')::bigint for update;
  if i.id is null then return false; end if;
  if i.order_id is not null then
    delete from jt.prep_order_lines l using jt.prep_orders o
    where o.id = i.order_id and o.status = 'draft' and l.order_id = o.id and l.variant_id = i.variant_id and l.amazon_sku = i.amazon_sku and l.dest = i.dest;
  end if;
  delete from jt.prep_list where id = i.id;
  return true;
end $$;
revoke all on function jt.prep_list_remove(jsonb) from public;

-- Orders: kind / place-by, and lines with dest. Lines replace the old ones before receiving; list items whose line
-- was taken off the order go back to "needs an order".
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
    kind = coalesce(nullif(p->>'kind', ''), kind),
    place_by = case when p ? 'place_by' then nullif(p->>'place_by', '')::date else place_by end,
    note = coalesce(p->>'note', note),
    short_ok = coalesce((p->>'short_ok')::boolean, short_ok),
    updated_at = now()
  where id = ord;
  if p ? 'lines' and st not in ('received', 'shipped') then
    delete from jt.prep_order_lines where order_id = ord;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost)
    select ord, (x->>'variant_id')::bigint, coalesce(x->>'amazon_sku', ''), coalesce(nullif(x->>'dest', ''), 'prep'),
      sum(coalesce((x->>'qty')::integer, 0)), max(nullif(x->>'unit_cost', '')::numeric)
    from jsonb_array_elements(p->'lines') x where coalesce((x->>'qty')::integer, 0) >= 0
    group by 2, 3, 4;
    update jt.prep_list i set order_id = null where i.order_id = ord and i.closed_at is null and not exists (
      select 1 from jt.prep_order_lines l where l.order_id = ord and l.variant_id = i.variant_id and l.amazon_sku = i.amazon_sku and l.dest = i.dest);
  end if;
  return ord;
end $$;

-- Receiving: 'prep' lines go into the prep center; 'shopify' lines are only recorded. List items on the order close.
create or replace function jt.prep_order_receive(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; st text; x jsonb; q integer; vid bigint; sku text; d text; n integer := 0; after integer; ref text;
begin
  select status, coalesce(nullif(po_no, ''), vendor || ' order ' || id) into st, ref from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
  if st = 'shipped' then raise exception 'this order is already shipped'; end if;
  for x in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    q := coalesce((x->>'qty')::integer, 0); vid := (x->>'variant_id')::bigint; sku := coalesce(x->>'amazon_sku', ''); d := coalesce(nullif(x->>'dest', ''), 'prep');
    if q < 0 then raise exception 'received quantities must be 0 or more'; end if;
    if q = 0 then continue; end if;
    if not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', vid; end if;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, qty_received) values (ord, vid, sku, d, 0, q)
      on conflict (order_id, variant_id, amazon_sku, dest) do update set qty_received = jt.prep_order_lines.qty_received + excluded.qty_received;
    if d = 'prep' then
      insert into jt.prep_items (variant_id, amazon_sku, qty) values (vid, sku, q)
        on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now()
        returning qty into after;
      insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
      values ('receive', vid, sku, q, after, ref, coalesce(p->>'note', ''), coalesce(p->>'by', ''), ord);
    end if;
    n := n + q;
  end loop;
  if n = 0 then raise exception 'nothing to receive'; end if;
  update jt.prep_orders set status = 'received', stage_at = case when st = 'received' then stage_at else stage_at || jsonb_build_object('received', now()) end,
    updated_at = now() where id = ord;
  update jt.prep_list set closed_at = now() where order_id = ord and closed_at is null;
  return n;
end $$;

-- Step back from received: only 'prep' lines come out of the prep center; list items on the order reopen.
create or replace function jt.prep_order_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; want text := p->>'status'; o record; l record; have integer; after integer;
begin
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  if o.status = want then return want; end if;
  if want in ('draft', 'ordered', 'invoice', 'packing_slip') then
    if o.status = 'shipped' then raise exception 'a shipped order goes back to received first'; end if;
    if o.status = 'received' then
      for l in select * from jt.prep_order_lines where order_id = ord and qty_received > 0 and dest = 'prep' loop
        select qty into have from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku for update;
        if coalesce(have, 0) < l.qty_received then
          raise exception 'only % of variant % % left in the prep center, % were received on this order — some already went out',
            coalesce(have, 0), l.variant_id, l.amazon_sku, l.qty_received;
        end if;
        update jt.prep_items set qty = qty - l.qty_received, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku
          returning qty into after;
        insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
        values ('unreceive', l.variant_id, l.amazon_sku, -l.qty_received, after, coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
          'moved back to ' || replace(want, '_', ' '), coalesce(p->>'by', ''), ord);
      end loop;
      delete from jt.prep_items where qty = 0;
      delete from jt.prep_order_lines where order_id = ord and qty_ordered = 0 and not exists (
        select 1 from jt.prep_list i where i.order_id = ord and i.variant_id = jt.prep_order_lines.variant_id and i.amazon_sku = jt.prep_order_lines.amazon_sku and i.dest = jt.prep_order_lines.dest);
      update jt.prep_order_lines set qty_received = 0 where order_id = ord;
      update jt.prep_orders set short_ok = false, stage_at = stage_at - 'received' - 'shipped' where id = ord;
      update jt.prep_list i set closed_at = null where i.order_id = ord and i.closed_at is not null
        and not exists (select 1 from jt.prep_list j where j.variant_id = i.variant_id and j.amazon_sku = i.amazon_sku and j.dest = i.dest and j.closed_at is null);
    end if;
  elsif want = 'received' then
    if o.status <> 'shipped' then raise exception 'use receive to take an order in'; end if;
    update jt.prep_orders set status = 'received', stage_at = stage_at - 'shipped', updated_at = now() where id = ord;
    return want;
  elsif want = 'shipped' then
    if o.status <> 'received' then raise exception 'only a received order can be marked shipped'; end if;
  else raise exception 'unknown status %', want; end if;
  update jt.prep_orders set status = want, stage_at = stage_at || jsonb_build_object(want, now()), updated_at = now() where id = ord;
  return want;
end $$;

-- Web wrappers (app users; "by" = signed-in email)
create or replace function public.jt_prep_list_add(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_list_add(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_prep_list_assign(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_list_assign(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_prep_list_remove(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_list_remove(p);
end $$;
revoke all on function public.jt_prep_list_add(jsonb), public.jt_prep_list_assign(jsonb), public.jt_prep_list_remove(jsonb) from public, anon;
grant execute on function public.jt_prep_list_add(jsonb), public.jt_prep_list_assign(jsonb), public.jt_prep_list_remove(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.prep_list to jt_reader;
  end if;
end $$;
