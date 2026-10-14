-- New products on a Shopify PO (Brian, Oct 14): Shopify's PO lines name an inventory item, which the PO sync turns
-- into a variant with jt.variants. A product created in Shopify that day isn't in jt.variants until the nightly catalog
-- sync, so its lines were saved with no variant — and a PO with only new products (#PO1254, #PO1255) was skipped by
-- jt.po_import_shopify ("no known lines") and never tried again.
-- Now: the PO sync refreshes the catalog first when a PO has an item it doesn't know (sync/shopify.py), and every
-- catalog sync (nightly, Sync from Shopify on Cost mapping, or that refresh) calls jt.po_lines_resolve(): lines with
-- no variant get theirs from the inventory item, and Shopify POs not brought in yet are tried again.
create or replace function jt.po_lines_resolve() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_lines int; n_pos int := 0; r record;
begin
  update jt.shopify_po_lines l set variant_id = v.variant_id
  from jt.variants v
  where l.variant_id is null and v.removed_at is null and v.inventory_item_id is not null
    and l.raw #>> '{inventoryItem,id}' ~ '[0-9]+$'
    and v.inventory_item_id = (substring(l.raw #>> '{inventoryItem,id}' from '([0-9]+)$'))::bigint;
  get diagnostics n_lines = row_count;
  for r in select p.id from jt.shopify_pos p
           where p.ss_imported_at is null and p.lines_synced is not null and p.created_at >= '2026-10-05'
             and upper(coalesce(p.status, '')) not in ('', 'DRAFT', 'CANCELLED', 'CANCELED')
             and exists (select 1 from jt.shopify_po_lines l join jt.variants v using (variant_id) where l.po_id = p.id)
           order by p.created_at loop
    if jt.po_import_shopify(r.id) is not null then n_pos := n_pos + 1; end if;
  end loop;
  return jsonb_build_object('lines', n_lines, 'imported', n_pos);
end $$;
revoke all on function jt.po_lines_resolve() from public;
