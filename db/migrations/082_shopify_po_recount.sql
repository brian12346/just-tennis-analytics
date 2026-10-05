-- Shopify POs: re-read the big ones and recount what's received, with the fixed sync.
-- The PO sync read at most 100 line items, so POs with more lines were cut short (11 POs, e.g. #PO1038 had 100 of its
-- 140 lines); it now pages through all of them. The first receipts run counted at most 50 lines per shipment; it now
-- takes each PO's total from Shopify's transfer totals and pages the shipments' lines. Both are redone on the next runs.
update jt.shopify_pos set lines_synced = null where lines >= 100;
update jt.shopify_pos set recv_status = '', recv_units = 0, receipt = null, recv_synced = null where recv_synced is not null;
update jt.shopify_po_lines set qty_received = 0 where qty_received <> 0;
