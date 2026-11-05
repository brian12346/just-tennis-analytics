-- Item detail › Inventory (Nov 5, Brian: "a historical inventory bar chart like on sales and then have the table below
-- with the details … want to see burn down/burn up rates"). Shopify's inventory history by month for every variant
-- (ShopifyQL FROM inventory: starting / ending units and units sold), filled by the sync (sync_inventory_monthly):
-- the last 13 months once, then the current month every hour and the previous month nightly.
-- Received / adjusted in a month = ending - starting + sold.
create table if not exists jt.inventory_monthly (
  variant_id   bigint not null,
  month        date not null,
  start_units  integer not null default 0,
  end_units    integer not null default 0,
  sold         integer not null default 0,
  seen_at      timestamptz not null default now(),
  primary key (variant_id, month)
);
create index if not exists inventory_monthly_month on jt.inventory_monthly (month);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.inventory_monthly to jt_reader; end if;
end $$;
