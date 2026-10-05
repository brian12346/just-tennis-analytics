-- Shopify POs: what's been received in Shopify (from each PO's inventory transfers; sync job shopify_po_receipts).
-- recv_status: none | partial | received ('' = not read yet). receipt keeps Shopify's transfers JSON.
alter table jt.shopify_pos add column if not exists recv_status text not null default '';
alter table jt.shopify_pos add column if not exists recv_units integer not null default 0;
alter table jt.shopify_pos add column if not exists receipt jsonb;
alter table jt.shopify_pos add column if not exists recv_synced timestamptz;
