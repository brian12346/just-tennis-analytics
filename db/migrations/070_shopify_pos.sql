-- Shopify purchase orders pulled through the Admin API (inventoryPurchaseOrders, API 2026-10, read-only), so a PO made
-- in Shopify can be brought into Seller Sage without uploading its PDF. Saved by the sync (job shopify-pos). Shopify
-- doesn't document these objects yet, so each PO and line keeps Shopify's full JSON (raw) next to the fields we read.
create table if not exists jt.shopify_pos (
  id            bigint primary key,          -- Shopify's purchase order ID (…/purchase_orders/<id> in the admin)
  name          text not null default '',    -- e.g. #PO1234
  status        text not null default '',
  supplier      text not null default '',
  destination   text not null default '',
  currency      text not null default '',
  total         numeric,
  lines         integer not null default 0,
  units         integer not null default 0,
  created_at    timestamptz,
  updated_at    timestamptz,
  expected_at   timestamptz,
  raw           jsonb,
  lines_synced  timestamptz,                 -- when the line items were last read (null: not yet)
  synced_at     timestamptz not null default now()
);
create index if not exists shopify_pos_created on jt.shopify_pos (created_at desc);

create table if not exists jt.shopify_po_lines (
  po_id        bigint not null references jt.shopify_pos (id) on delete cascade,
  line_id      text not null,                -- Shopify's line item ID (or the position when there is none)
  variant_id   bigint,
  sku          text not null default '',
  title        text not null default '',
  qty          integer not null default 0,   -- ordered
  qty_received integer not null default 0,
  cost         numeric,                      -- unit cost on the PO
  raw          jsonb,
  primary key (po_id, line_id)
);
create index if not exists shopify_po_lines_variant on jt.shopify_po_lines (variant_id);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.shopify_pos, jt.shopify_po_lines to jt_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.shopify_pos, jt.shopify_po_lines to fin_reader; end if;
end $$;
