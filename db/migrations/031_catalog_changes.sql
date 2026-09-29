-- What each catalog sync from Shopify changed, product by product, for the "What changed" pop-up.
-- One row per change: kind is one of new, removed, restored, cost, price, stock, status, title, sku, barcode,
-- vendor or type, with the old and new value as text. synced_at is the sync's time (jt.variants.seen_at for that
-- run). The sync keeps 120 days.

create table if not exists jt.catalog_changes (
  id bigint generated always as identity primary key,
  synced_at timestamptz not null,
  variant_id bigint not null,
  kind text not null,
  old text,
  new text
);
create index if not exists catalog_changes_synced_idx on jt.catalog_changes (synced_at);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.catalog_changes to jt_reader;
  end if;
end $$;
