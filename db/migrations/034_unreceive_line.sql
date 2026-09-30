-- Un-receiving part of one product on a purchase order (not the whole PO). Prep-center units come back out of the
-- prep center (logged as 'unreceive'); Shopify-store units are only taken off the PO's received count. The PO's
-- stage follows: nothing received -> invoiced (ordered if it has no invoice), some -> partly received.
-- Not allowed once the PO is QB ready or complete (move it back to received first).
-- p = {id (order), variant_id, amazon_sku, dest, qty, note, by}

create or replace function jt.prep_order_unreceive_line(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; o record; l record; q integer := coalesce((p->>'qty')::integer, 0); have integer; after integer; tot integer; full_ boolean;
begin
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  if o.status in ('qb_ready', 'complete') then raise exception 'this order is %; move it back to received first', replace(o.status, '_', ' '); end if;
  select * into l from jt.prep_order_lines where order_id = ord and variant_id = (p->>'variant_id')::bigint
    and amazon_sku = coalesce(p->>'amazon_sku', '') and dest = coalesce(nullif(p->>'dest', ''), 'prep') for update;
  if l.order_id is null then raise exception 'that product isn''t on this order'; end if;
  if q <= 0 then raise exception 'enter how many to un-receive'; end if;
  if q > l.qty_received then raise exception 'only % of this product were received on this order', l.qty_received; end if;
  if l.dest = 'prep' then
    select qty into have from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku for update;
    if coalesce(have, 0) < q then
      raise exception 'only % of this product are left in the prep center; the rest already went out', coalesce(have, 0);
    end if;
    update jt.prep_items set qty = qty - q, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku returning qty into after;
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
    values ('unreceive', l.variant_id, l.amazon_sku, -q, after, coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
            coalesce(nullif(p->>'note', ''), 'un-received on the PO'), coalesce(p->>'by', ''), ord);
    delete from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku and qty = 0;
  end if;
  update jt.prep_order_lines set qty_received = qty_received - q
  where order_id = ord and variant_id = l.variant_id and amazon_sku = l.amazon_sku and dest = l.dest;
  select coalesce(sum(qty_received), 0), not exists (select 1 from jt.prep_order_lines where order_id = ord and qty_received < qty_ordered)
    into tot, full_ from jt.prep_order_lines where order_id = ord;
  if o.status in ('partial', 'received') then
    if tot = 0 then
      update jt.prep_orders set status = case when exists (select 1 from jt.invoices where order_id = ord) then 'invoiced' else 'ordered' end,
        short_ok = false, stage_at = stage_at - 'partial' - 'received', updated_at = now() where id = ord;
    elsif not full_ and not o.short_ok then
      update jt.prep_orders set status = 'partial', stage_at = stage_at - 'received', updated_at = now() where id = ord;
    else
      update jt.prep_orders set updated_at = now() where id = ord;
    end if;
  end if;
  return q;
end $$;
revoke all on function jt.prep_order_unreceive_line(jsonb) from public;

create or replace function public.jt_prep_order_unreceive_line(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_order_unreceive_line(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_order_unreceive_line(jsonb) from public, anon;
grant execute on function public.jt_prep_order_unreceive_line(jsonb) to authenticated;
