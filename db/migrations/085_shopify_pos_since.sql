-- Shopify POs: keep only new ones (Brian, Oct 5, 2026: the 1,200+ old POs only slowed the Purchase orders page down;
-- received status is read from Shopify now). Seller Sage keeps Shopify POs created on or after jt.settings
-- 'shopify_pos_since' (Pacific date; the sync skips older ones), plus any older one a Seller Sage PO links to.
insert into jt.settings (key, value) values ('shopify_pos_since', '"2026-10-05"'::jsonb)
on conflict (key) do update set value = excluded.value;

delete from jt.shopify_pos p   -- their lines go with them (foreign key, on delete cascade)
where (coalesce(p.created_at, (p.raw ->> 'dateCreated')::timestamptz, '-infinity') at time zone 'America/Los_Angeles')::date < '2026-10-05'
  and p.id not in (select substring(o.shopify_po_url from '/purchase_orders/([0-9]+)')::bigint
                   from jt.prep_orders o where o.shopify_po_url ~ '/purchase_orders/[0-9]+');
