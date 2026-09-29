-- The linked Shopify PO's own status (Draft, Ordered, Partially received, Received, Closed...), read by the sync.
-- Shopify's API for purchase orders (inventoryPurchaseOrders) is a preview that live stores can't use yet. The
-- nightly and catalog syncs try it anyway. If the store is refused, they record why in jt.settings
-- ('shopify_po_api') and leave the statuses empty, so statuses show up by themselves once Shopify opens it.
-- A PO whose Shopify status turns received is marked "Received in Shopify" (by 'Shopify') if it wasn't already.

alter table jt.prep_orders add column if not exists shopify_po_status text not null default '';
alter table jt.prep_orders add column if not exists shopify_po_status_at timestamptz;
