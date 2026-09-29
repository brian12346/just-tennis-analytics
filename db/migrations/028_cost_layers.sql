-- New costs from a purchase order, pushed to Shopify in bulk, and cost layers for inventory value.
--
-- A PO line can be marked to update the Shopify cost (update_cost). "Apply to Shopify" on the PO works only on
-- lines that have been received. Shopify gets the weighted average of everything on hand:
--   - the older units at their old cost, and
--   - the received units at the PO cost.
-- The dashboard works that number out (on hand = Shopify + prep center + Amazon) and queues it the usual way
-- (jt.cost_updates -> the cost-updates sync).
--
-- Inventory value uses FIFO cost layers. The first time a product's cost is applied from a PO, the units it had on
-- hand before that PO are kept as its opening layer, at the cost it had then (jt.cost_layers). From then on, every
-- PO receipt of the product is a layer at its PO cost (jt.v_cost_layers, worked out from the PO lines, so later
-- receipts and un-receipts count). Stock on hand is valued newest layer first; anything beyond the layers is at the
-- opening cost. Products never applied from a PO keep being valued at the Shopify cost.

alter table jt.prep_order_lines add column if not exists update_cost boolean not null default false;
alter table jt.prep_order_lines add column if not exists cost_applied numeric(12,4);        -- the cost sent to Shopify
alter table jt.prep_order_lines add column if not exists cost_applied_at timestamptz;

create table if not exists jt.cost_layers (
  id bigint generated always as identity primary key,
  variant_id bigint not null unique,              -- one opening layer per product
  qty integer not null check (qty >= 0),
  unit_cost numeric(12,4) not null,
  at timestamptz not null,                        -- PO receipts from here on are layers
  order_id bigint,                                -- the PO whose apply started the layers
  created_at timestamptz not null default now(),
  created_by text not null default ''
);

create or replace view jt.v_cost_layers as
select c.variant_id, 'opening'::text as kind, null::bigint as order_id, ''::text as po_no, c.qty, c.unit_cost, c.at
from jt.cost_layers c
union all
select l.variant_id, 'po', l.order_id, max(coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || o.id)), sum(l.qty_received)::integer,
  round(sum(l.qty_received * coalesce(l.unit_cost, c.unit_cost)) / sum(l.qty_received), 4),
  min(coalesce((o.stage_at->>'partial')::timestamptz, (o.stage_at->>'received')::timestamptz, o.updated_at))
from jt.prep_order_lines l
join jt.prep_orders o on o.id = l.order_id
join jt.cost_layers c on c.variant_id = l.variant_id
where l.qty_received > 0
  and coalesce((o.stage_at->>'partial')::timestamptz, (o.stage_at->>'received')::timestamptz, o.updated_at) >= c.at
group by l.variant_id, l.order_id;

-- p = {order_id, by, items: [{variant_id, cost, opening: {qty, unit_cost, at} | null}]}
-- Queues each cost for Shopify, records it on the PO's lines, and starts a product's cost layers if it has none.
create or replace function jt.po_apply_costs(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'order_id')::bigint; x jsonb; n integer;
begin
  if not exists (select 1 from jt.prep_orders where id = ord) then raise exception 'order % not found', ord; end if;
  for x in select * from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
    if not exists (select 1 from jt.prep_order_lines where order_id = ord and variant_id = (x->>'variant_id')::bigint and qty_received > 0) then
      raise exception 'variant % hasn''t been received on this order', x->>'variant_id';
    end if;
    if nullif(x->>'cost', '') is null or (x->>'cost')::numeric < 0 then raise exception 'a cost is needed for variant %', x->>'variant_id'; end if;
    if jsonb_typeof(x->'opening') = 'object' then
      insert into jt.cost_layers (variant_id, qty, unit_cost, at, order_id, created_by)
      values ((x->>'variant_id')::bigint, greatest(0, coalesce((x->'opening'->>'qty')::integer, 0)), (x->'opening'->>'unit_cost')::numeric,
              (x->'opening'->>'at')::timestamptz, ord, coalesce(p->>'by', ''))
      on conflict (variant_id) do nothing;
    end if;
    update jt.prep_order_lines set cost_applied = (x->>'cost')::numeric, cost_applied_at = now(), update_cost = false
    where order_id = ord and variant_id = (x->>'variant_id')::bigint;
  end loop;
  n := jt.queue_cost_updates(coalesce((select jsonb_agg(jsonb_build_object('variant_id', (e->>'variant_id')::bigint, 'cost', (e->>'cost')::numeric))
                                        from jsonb_array_elements(p->'items') e), '[]'::jsonb));
  return n;
end $$;
revoke all on function jt.po_apply_costs(jsonb) from public;

create or replace function public.jt_po_apply_costs(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_apply_costs(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_po_apply_costs(jsonb) from public, anon;
grant execute on function public.jt_po_apply_costs(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.cost_layers, jt.v_cost_layers to jt_reader;
  end if;
end $$;

-- PO save: lines can change until complete; each invoice's payment details are saved too (also on applied invoices).
create or replace function jt.po_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare o jsonb := coalesce(p->'order', '{}'::jsonb) - 'lines' - 'invoice_id'; ord bigint; st text; i jsonb; inv bigint; ist text; ids jsonb := '[]'::jsonb; x jsonb;
begin
  ord := jt.prep_order_save(o || jsonb_build_object('by', coalesce(p->>'by', '')));
  select status into st from jt.prep_orders where id = ord;
  if p ? 'lines' and st <> 'complete' then
    for x in select * from jsonb_array_elements(p->'lines') loop
      if coalesce((x->>'qty')::integer, 0) < 0 then raise exception 'quantities must be 0 or more'; end if;
    end loop;
    with want as (
      select (e->>'variant_id')::bigint as variant_id, coalesce(e->>'amazon_sku', '') as amazon_sku, coalesce(nullif(e->>'dest', ''), 'prep') as dest,
        sum(coalesce((e->>'qty')::integer, 0))::integer as qty, max(nullif(e->>'unit_cost', '')::numeric) as unit_cost,
        bool_or(coalesce((e->>'backorder')::boolean, false)) as backorder, max(nullif(e->>'eta', '')::date) as eta,
        bool_or(coalesce((e->>'update_cost')::boolean, false)) as update_cost
      from jsonb_array_elements(p->'lines') e group by 1, 2, 3
    ), gone as (
      delete from jt.prep_order_lines l where l.order_id = ord and l.qty_received = 0
        and not exists (select 1 from want w where w.variant_id = l.variant_id and w.amazon_sku = l.amazon_sku and w.dest = l.dest)
    )
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost, backorder, eta, update_cost)
    select ord, variant_id, amazon_sku, dest, qty, unit_cost, backorder, eta, update_cost from want
    on conflict (order_id, variant_id, amazon_sku, dest) do update set qty_ordered = excluded.qty_ordered, unit_cost = excluded.unit_cost,
      backorder = excluded.backorder, eta = excluded.eta, update_cost = excluded.update_cost;
    update jt.prep_list li set order_id = null where li.order_id = ord and li.closed_at is null and not exists (
      select 1 from jt.prep_order_lines l where l.order_id = ord and l.variant_id = li.variant_id and l.amazon_sku = li.amazon_sku and l.dest = li.dest);
  end if;
  -- invoices taken off the order: a draft is deleted, an applied one is only detached
  delete from jt.invoices where order_id = ord and status = 'draft' and id in (select (y #>> '{}')::bigint from jsonb_array_elements(coalesce(p->'remove_invoices', '[]'::jsonb)) y);
  update jt.invoices set order_id = null where order_id = ord and id in (select (y #>> '{}')::bigint from jsonb_array_elements(coalesce(p->'remove_invoices', '[]'::jsonb)) y);
  for i in select * from jsonb_array_elements(coalesce(p->'invoices', '[]'::jsonb)) loop
    inv := nullif(i->>'id', '')::bigint; ist := null;
    if inv is not null then select status into ist from jt.invoices where id = inv; end if;
    if inv is null or ist is distinct from 'applied' then
      inv := jt.save_invoice(i || jsonb_build_object('po_no', coalesce(o->>'po_no', i->>'po_no', '')));
    end if;
    update jt.invoices set order_id = ord where id = inv;
    perform jt.invoice_set_payment(inv, i - 'id' - 'lines');
    ids := ids || to_jsonb(inv);
  end loop;
  update jt.prep_orders set invoice_id = (select max(id) from jt.invoices where order_id = ord) where id = ord;
  perform jt.remember_vendor_items(jsonb_build_object('vendor', (select vendor from jt.prep_orders where id = ord), 'items', coalesce(p->'remember', '[]'::jsonb)));
  return jsonb_build_object('order_id', ord, 'invoice_ids', ids);
end $$;
