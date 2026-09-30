-- Receiving against an invoice. A PO can have several invoices. Receiving can be done against one of them: the
-- units go into the PO as before (jt.prep_order_receive), and they're also counted on that invoice, by product
-- (jt.invoice_receipts). An invoice is received once every product on it has come in (received_at). It can also
-- be marked received by hand (received_manual), e.g. when the vendor shipped fewer than they billed. The PO stays
-- partly received while its backordered products are still to come.

create table if not exists jt.invoice_receipts (
  invoice_id bigint not null references jt.invoices (id) on delete cascade,
  variant_id bigint not null,
  qty numeric(12,2) not null default 0,
  primary key (invoice_id, variant_id)
);
alter table jt.invoices add column if not exists received_at timestamptz;
alter table jt.invoices add column if not exists received_manual boolean not null default false;

-- An invoice is received when each product on it (matched lines that aren't charges) has come in.
create or replace function jt.invoice_refresh_received(inv bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare done boolean;
begin
  select not exists (
    select 1 from (select variant_id, sum(coalesce(qty, 0)) as q from jt.invoice_lines
                   where invoice_id = inv and variant_id is not null and match_how <> 'skip' group by 1) b
    left join jt.invoice_receipts r on r.invoice_id = inv and r.variant_id = b.variant_id
    where coalesce(r.qty, 0) < b.q)
    and exists (select 1 from jt.invoice_receipts where invoice_id = inv and qty > 0)
  into done;
  update jt.invoices set received_at = case when done or received_manual then coalesce(received_at, now()) else null end where id = inv;
  return done;
end $$;
revoke all on function jt.invoice_refresh_received(bigint) from public;

-- p = {id (order), invoice_id (optional), lines: [{variant_id, amazon_sku, dest, qty}], note, by}
create or replace function jt.po_receive_invoice(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; inv bigint := nullif(p->>'invoice_id', '')::bigint; n integer; x record; room numeric;
begin
  if inv is not null and not exists (select 1 from jt.invoices where id = inv and order_id = ord) then
    raise exception 'invoice % isn''t on this order', inv;
  end if;
  n := jt.prep_order_receive(p - 'invoice_id');
  if inv is not null then
    for x in select (e->>'variant_id')::bigint as vid, sum(coalesce((e->>'qty')::numeric, 0)) as q
             from jsonb_array_elements(p->'lines') e group by 1 loop
      -- counted on the invoice up to what it billed for that product
      select greatest(0, coalesce(sum(il.qty), 0) - coalesce((select qty from jt.invoice_receipts where invoice_id = inv and variant_id = x.vid), 0))
        into room from jt.invoice_lines il where il.invoice_id = inv and il.variant_id = x.vid and il.match_how <> 'skip';
      if least(x.q, room) > 0 then
        insert into jt.invoice_receipts (invoice_id, variant_id, qty) values (inv, x.vid, least(x.q, room))
        on conflict (invoice_id, variant_id) do update set qty = jt.invoice_receipts.qty + excluded.qty;
      end if;
    end loop;
    perform jt.invoice_refresh_received(inv);
  end if;
  return n;
end $$;
revoke all on function jt.po_receive_invoice(jsonb) from public;

-- Marking an invoice received by hand (received = false undoes it). p = {invoice_id, received}
create or replace function jt.invoice_set_received(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare inv bigint := (p->>'invoice_id')::bigint;
begin
  update jt.invoices set received_manual = coalesce((p->>'received')::boolean, true) where id = inv;
  if not found then raise exception 'invoice % not found', inv; end if;
  return jt.invoice_refresh_received(inv) or coalesce((p->>'received')::boolean, true);
end $$;
revoke all on function jt.invoice_set_received(jsonb) from public;

create or replace function public.jt_po_receive_invoice(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_receive_invoice(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_invoice_set_received(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_set_received(p);
end $$;
revoke all on function public.jt_po_receive_invoice(jsonb), public.jt_invoice_set_received(jsonb) from public, anon;
grant execute on function public.jt_po_receive_invoice(jsonb), public.jt_invoice_set_received(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.invoice_receipts to jt_reader; end if;
end $$;

-- un-receiving one product also takes it off the order's invoices (newest first)
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
  -- take them off the order's invoices too, newest invoice first
  declare left_ numeric := q; r record; t numeric;
  begin
    for r in select ir.invoice_id, ir.qty from jt.invoice_receipts ir join jt.invoices i on i.id = ir.invoice_id
             where i.order_id = ord and ir.variant_id = l.variant_id and ir.qty > 0 order by ir.invoice_id desc loop
      exit when left_ <= 0;
      t := least(left_, r.qty);
      update jt.invoice_receipts set qty = qty - t where invoice_id = r.invoice_id and variant_id = l.variant_id;
      perform jt.invoice_refresh_received(r.invoice_id);
      left_ := left_ - t;
    end loop;
  end;
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
