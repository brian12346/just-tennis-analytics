-- Purchase orders: a Seller Sage PO linked to a Shopify PO by hand (the Shopify PO field, or Create Seller Sage PO)
-- catches up with Shopify right away — what Shopify has already received is received here (migration 129's rules), and
-- the Shopify PO is marked as brought in (ss_order_id), so it's never brought in again or suggested elsewhere. Before,
-- receipts only followed when the sync saw a change on the Shopify PO (PO 21 / #PO1125: 98 of 120 already in).
create or replace function jt.trg_po_link_catch_up() returns trigger
language plpgsql security definer set search_path = '' as $$
declare spo bigint := nullif(substring(new.shopify_po_url from '/purchase_orders/([0-9]+)'), '')::bigint;
begin
  if spo is null or (tg_op = 'UPDATE' and new.shopify_po_url is not distinct from old.shopify_po_url) then return null; end if;
  -- (an ss_order_id whose Seller Sage PO was deleted is taken over)
  update jt.shopify_pos x set ss_imported_at = coalesce(x.ss_imported_at, now()), ss_order_id = new.id, ss_suggest = '{}'
  where x.id = spo and (x.ss_order_id is null or not exists (select 1 from jt.prep_orders o where o.id = x.ss_order_id));
  if exists (select 1 from jt.shopify_pos where id = spo) then perform jt.po_follow_shopify(spo::text); end if;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'po_link_catch_up') then
    create trigger po_link_catch_up after insert or update of shopify_po_url on jt.prep_orders
      for each row execute function jt.trg_po_link_catch_up();
  end if;
end $$;

-- catch up the POs linked so far
do $$ declare r record; begin
  for r in select o.id, substring(o.shopify_po_url from '/purchase_orders/([0-9]+)')::bigint as spo from jt.prep_orders o
           where o.shopify_po_url ~ '/purchase_orders/[0-9]+' and o.status <> 'draft' loop
    update jt.shopify_pos x set ss_imported_at = coalesce(x.ss_imported_at, now()), ss_order_id = r.id, ss_suggest = '{}'
    where x.id = r.spo and (x.ss_order_id is null or not exists (select 1 from jt.prep_orders o where o.id = x.ss_order_id));
    if exists (select 1 from jt.shopify_pos where id = r.spo) then perform jt.po_follow_shopify(r.spo::text); end if;
  end loop;
end $$;
