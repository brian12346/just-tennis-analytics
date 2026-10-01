-- Units received on a PO always count on its invoices. Receiving that didn't name an invoice (an older version of the
-- dashboard, "Receive without an invoice", the Prep center, maintenance) left jt.invoice_receipts behind the PO, so an
-- invoice could say "not received" on a fully received PO. jt.invoice_receipts_sync(order) adds what the PO received
-- for each product and no invoice has counted yet to the order's invoices, oldest invoice first, up to what each
-- billed. A trigger runs it whenever a PO line's received count goes up — except inside jt.po_receive_invoice, which
-- counts the units on the invoice it was given.

create or replace function jt.invoice_receipts_sync(ord bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare x record; r record; gap numeric; t numeric; n integer := 0; inv bigint;
begin
  for x in
    select l.variant_id, sum(l.qty_received) as rec,
      coalesce((select sum(ir.qty) from jt.invoice_receipts ir join jt.invoices i on i.id = ir.invoice_id where i.order_id = ord and ir.variant_id = l.variant_id), 0) as att
    from jt.prep_order_lines l where l.order_id = ord group by l.variant_id
  loop
    gap := x.rec - x.att;
    continue when gap <= 0;
    for r in
      select il.invoice_id, sum(il.qty) - coalesce((select qty from jt.invoice_receipts where invoice_id = il.invoice_id and variant_id = x.variant_id), 0) as room
      from jt.invoice_lines il join jt.invoices i on i.id = il.invoice_id
      where i.order_id = ord and il.variant_id = x.variant_id and il.match_how <> 'skip'
      group by il.invoice_id order by il.invoice_id
    loop
      exit when gap <= 0;
      t := least(gap, r.room); continue when t <= 0;
      insert into jt.invoice_receipts (invoice_id, variant_id, qty) values (r.invoice_id, x.variant_id, t)
      on conflict (invoice_id, variant_id) do update set qty = jt.invoice_receipts.qty + excluded.qty;
      gap := gap - t; n := n + 1;
    end loop;
  end loop;
  for inv in select id from jt.invoices where order_id = ord loop perform jt.invoice_refresh_received(inv); end loop;
  return n;
end $$;
revoke all on function jt.invoice_receipts_sync(bigint) from public;

create or replace function jt.trg_invoice_receipts_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(current_setting('jt.receiving_invoice', true), '') = '' and new.qty_received > coalesce(old.qty_received, 0) then
    perform jt.invoice_receipts_sync(new.order_id);
  end if;
  return null;
end $$;
-- (created once; the Supabase API asks for approval on DROP, so there is no drop-and-recreate here)
do $$ begin if not exists (select 1 from pg_trigger where tgname = 'invoice_receipts_sync') then
create trigger invoice_receipts_sync after insert or update of qty_received on jt.prep_order_lines
  for each row execute function jt.trg_invoice_receipts_sync();
end if; end $$;

-- receiving against a chosen invoice: the trigger stays out of the way, then anything left over is synced
create or replace function jt.po_receive_invoice(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; inv bigint := nullif(p->>'invoice_id', '')::bigint; n integer; x record; room numeric;
begin
  if inv is not null and not exists (select 1 from jt.invoices where id = inv and order_id = ord) then
    raise exception 'invoice % isn''t on this order', inv;
  end if;
  perform set_config('jt.receiving_invoice', coalesce(inv::text, 'none'), true);
  n := jt.prep_order_receive(p - 'invoice_id');
  perform set_config('jt.receiving_invoice', '', true);
  if inv is not null then
    for x in select (e->>'variant_id')::bigint as vid, sum(coalesce((e->>'qty')::numeric, 0)) as q
             from jsonb_array_elements(p->'lines') e group by 1 loop
      select greatest(0, coalesce(sum(il.qty), 0) - coalesce((select qty from jt.invoice_receipts where invoice_id = inv and variant_id = x.vid), 0))
        into room from jt.invoice_lines il where il.invoice_id = inv and il.variant_id = x.vid and il.match_how <> 'skip';
      if least(x.q, room) > 0 then
        insert into jt.invoice_receipts (invoice_id, variant_id, qty) values (inv, x.vid, least(x.q, room))
        on conflict (invoice_id, variant_id) do update set qty = jt.invoice_receipts.qty + excluded.qty;
      end if;
    end loop;
    perform jt.invoice_refresh_received(inv);
  end if;
  perform jt.invoice_receipts_sync(ord);
  return n;
end $$;
revoke all on function jt.po_receive_invoice(jsonb) from public;

-- catch up every PO
do $$ declare o bigint; begin for o in select id from jt.prep_orders loop perform jt.invoice_receipts_sync(o); end loop; end $$;
