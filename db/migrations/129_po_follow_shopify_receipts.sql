-- Purchase orders: Shopify-store lines follow Shopify (Brian, Oct 12 — "I received the products in the Shopify PO and
-- the Seller Sage PO doesn't have them received"). POs are received in Shopify; a Seller Sage PO linked to a Shopify PO
-- now picks up what Shopify received on its Shopify-store lines by itself, through the usual receive
-- (jt.prep_order_receive: the PO's status, its invoices' received counts, the prep list), up to what each line ordered —
-- a Shopify PO can cover more than the Seller Sage one. It only ever adds (un-receiving stays manual), never touches
-- prep-center lines, and stamps "received in Shopify" (shopify_received_at, which applying costs waits for) once the
-- Shopify PO is fully received. Runs when the sync saves a Shopify PO's receipts (triggers below), and once now.
create or replace function jt.po_follow_shopify(spo text) returns integer
language plpgsql security definer set search_path = '' as $$
declare o record; lines jsonb; n integer := 0;
begin
  for o in
    select p.id from jt.prep_orders p
    where p.shopify_po_url ~ ('/purchase_orders/' || spo || '([/?#]|$)') and p.status <> 'draft'
  loop
    select coalesce(jsonb_agg(jsonb_build_object('variant_id', x.variant_id, 'amazon_sku', x.sku, 'dest', 'shopify', 'qty', x.gap)), '[]'::jsonb)
      into lines
    from (
      select l.variant_id, l.sku, least(s.got, l.ordered) - l.rec as gap
      from (select variant_id, max(amazon_sku) as sku, sum(qty_ordered) as ordered, sum(qty_received) as rec
            from jt.prep_order_lines where order_id = o.id and dest = 'shopify' group by variant_id) l
      join (select variant_id, sum(qty_received) as got from jt.shopify_po_lines where po_id::text = spo and variant_id is not null group by variant_id) s
        on s.variant_id = l.variant_id
      where least(s.got, l.ordered) > l.rec) x;
    if jsonb_array_length(lines) > 0 then
      n := n + jt.prep_order_receive(jsonb_build_object('id', o.id, 'lines', lines, 'by', 'Shopify', 'note', 'received in Shopify'));
    end if;
    update jt.prep_orders set shopify_received_at = now(), shopify_received_by = 'Shopify'
    where id = o.id and shopify_received_at is null
      and exists (select 1 from jt.shopify_pos where id::text = spo and recv_status = 'received');
  end loop;
  return n;
end $$;
revoke all on function jt.po_follow_shopify(text) from public;

create or replace function jt.trg_po_follow_shopify_line() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.qty_received > coalesce(old.qty_received, 0) then perform jt.po_follow_shopify(new.po_id::text); end if;
  return null;
end $$;
create or replace function jt.trg_po_follow_shopify_po() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.recv_status = 'received' and coalesce(old.recv_status, '') <> 'received' then perform jt.po_follow_shopify(new.id::text); end if;
  return null;
end $$;
-- (created once; the Supabase API asks for approval on DROP, so there is no drop-and-recreate here)
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'po_follow_shopify_line') then
    create trigger po_follow_shopify_line after update of qty_received on jt.shopify_po_lines
      for each row execute function jt.trg_po_follow_shopify_line();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'po_follow_shopify_po') then
    create trigger po_follow_shopify_po after update of recv_status on jt.shopify_pos
      for each row execute function jt.trg_po_follow_shopify_po();
  end if;
end $$;

-- catch up the POs whose Shopify receipts are already in
do $$ declare r record; begin
  for r in select distinct sp.id::text as id from jt.shopify_pos sp
           join jt.prep_orders o on o.shopify_po_url ~ ('/purchase_orders/' || sp.id || '([/?#]|$)')
           where sp.recv_units > 0 loop
    perform jt.po_follow_shopify(r.id);
  end loop;
end $$;
