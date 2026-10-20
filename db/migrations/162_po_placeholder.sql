-- Placeholder orders (Brian, Oct 20: "We need a way to create a placeholder Order - basically just choose the vendor,
-- category, and budget. Only require vendor, but flag missing data. Then allow an invoice to be assigned to the order and
-- it starts filling it out.")
--   * prep_orders.category (free text, e.g. Racquets, Shoes, Fall booking) and budget ($, the most to spend on it);
--     placeholder = made that way (no products yet). Made as Ordered: it's with the vendor, waiting for invoices.
--   * jt.po_placeholder_create {vendor (required), category, budget, po_no, expected_on}; jt.po_plan_set {id, category,
--     budget} (category/budget on any PO).
--   * An invoice put on a PO (Change PO / Add to a PO, jt.invoice_move) adds its products that aren't on the PO yet as
--     lines: invoiced quantity, invoice cost, received into the PO's "receive into" (Shopify store unless prep). An
--     Ordered PO becomes Invoiced. (Uploading an invoice onto a PO already did this on the page.)

alter table jt.prep_orders add column if not exists category text not null default '';
alter table jt.prep_orders add column if not exists budget numeric(12,2);
alter table jt.prep_orders add column if not exists placeholder boolean not null default false;

create or replace function jt.po_placeholder_create(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare ord bigint; v text := btrim(coalesce(p->>'vendor', ''));
begin
  if v = '' then raise exception 'pick the vendor'; end if;
  if nullif(p->>'budget', '') is not null and (p->>'budget')::numeric < 0 then raise exception 'the budget can''t be negative'; end if;
  insert into jt.prep_orders (vendor, po_no, category, budget, placeholder, status, expected_on, created_by, stage_at, receive_into)
  values (v, btrim(coalesce(p->>'po_no', '')), btrim(coalesce(p->>'category', '')), nullif(p->>'budget', '')::numeric, true, 'ordered',
          nullif(p->>'expected_on', '')::date, coalesce(p->>'by', ''), jsonb_build_object('draft', now(), 'ordered', now()),
          case when p->>'receive_into' in ('shopify', 'prep', 'both') then p->>'receive_into' else 'shopify' end)
  returning id into ord;
  return ord;
end $$;
revoke all on function jt.po_placeholder_create(jsonb) from public;

create or replace function jt.po_plan_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if nullif(p->>'budget', '') is not null and (p->>'budget')::numeric < 0 then raise exception 'the budget can''t be negative'; end if;
  update jt.prep_orders set
    category = case when p ? 'category' then btrim(coalesce(p->>'category', '')) else category end,
    budget = case when p ? 'budget' then nullif(p->>'budget', '')::numeric else budget end,
    updated_at = now()
  where id = (p->>'id')::bigint;
  if not found then raise exception 'purchase order % not found', p->>'id'; end if;
  return true;
end $$;
revoke all on function jt.po_plan_set(jsonb) from public;

-- an invoice's matched products that aren't on the PO yet become lines (invoiced quantity, average invoice cost)
create or replace function jt.po_fill_from_invoice(ord bigint, inv bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer; d text;
begin
  select case when receive_into = 'prep' then 'prep' else 'shopify' end into d from jt.prep_orders where id = ord;
  insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, unit_cost)
  select ord, il.variant_id, '', d, greatest(0, round(sum(coalesce(il.qty, 0))))::integer,
         case when sum(coalesce(il.qty, 0)) > 0 then round(sum(coalesce(il.qty, 0) * coalesce(il.unit_cost, 0)) / sum(coalesce(il.qty, 0)), 4) else max(il.unit_cost) end
  from jt.invoice_lines il
  where il.invoice_id = inv and il.variant_id is not null and coalesce(il.match_how, '') <> 'skip' and coalesce(il.match_how, '') not like 'guess%'
    and not exists (select 1 from jt.prep_order_lines l where l.order_id = ord and l.variant_id = il.variant_id)
  group by il.variant_id
  on conflict (order_id, variant_id, amazon_sku, dest) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function jt.po_fill_from_invoice(bigint, bigint) from public;

-- put a saved invoice on another PO; what was received against it goes along. p = {invoice_id, order_id}
create or replace function jt.invoice_move(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare inv bigint := (p->>'invoice_id')::bigint; ord bigint := (p->>'order_id')::bigint; old bigint; st text; r record; l record;
  left_ integer; t integer; pt integer;
begin
  select coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1)) into old from jt.invoices i where i.id = inv;
  if not found then raise exception 'invoice % not found', inv; end if;
  select status into st from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'purchase order % not found', ord; end if;
  if old = ord then return true; end if;
  -- the invoice's products that aren't on the PO yet go onto it first (a placeholder order fills out from its invoices);
  -- then what was received against the invoice lands on those lines
  perform jt.po_fill_from_invoice(ord, inv);
  if old is not null then
    perform 1 from jt.prep_orders where id = old for update;
    for r in select variant_id, qty::integer as qty from jt.invoice_receipts where invoice_id = inv and qty > 0 loop
      left_ := r.qty;
      for l in select * from jt.prep_order_lines where order_id = old and variant_id = r.variant_id and qty_received > 0
               order by (dest = 'shopify') desc, qty_received desc loop
        exit when left_ <= 0;
        t := least(left_, l.qty_received); pt := least(t, l.qty_pushed);
        update jt.prep_order_lines set qty_received = qty_received - t, qty_pushed = qty_pushed - pt
        where order_id = old and variant_id = l.variant_id and amazon_sku = l.amazon_sku and dest = l.dest;
        insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, qty_received, qty_pushed)
        values (ord, l.variant_id, l.amazon_sku, l.dest, 0, t, pt)
        on conflict (order_id, variant_id, amazon_sku, dest) do update
          set qty_received = jt.prep_order_lines.qty_received + excluded.qty_received, qty_pushed = jt.prep_order_lines.qty_pushed + excluded.qty_pushed;
        left_ := left_ - t;
      end loop;
    end loop;
  end if;
  update jt.invoices set order_id = ord, updated_at = now() where id = inv;
  update jt.prep_orders o set invoice_id = (select max(id) from jt.invoices where order_id = o.id), updated_at = now() where o.id in (ord, old);
  if exists (select 1 from jt.invoice_receipts where invoice_id = inv and qty > 0) then
    perform jt.po_restage(ord);
    if old is not null then perform jt.po_restage(old); end if;
  elsif st = 'ordered' then
    update jt.prep_orders set status = 'invoiced', stage_at = stage_at || jsonb_build_object('invoiced', now()), updated_at = now() where id = ord;
  end if;
  return true;
end $$;
revoke all on function jt.invoice_move(jsonb) from public;

create or replace function public.jt_po_placeholder_create(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_placeholder_create(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_po_plan_set(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_plan_set(p);
end $$;
revoke all on function public.jt_po_placeholder_create(jsonb), public.jt_po_plan_set(jsonb) from public, anon;
grant execute on function public.jt_po_placeholder_create(jsonb), public.jt_po_plan_set(jsonb) to authenticated;
