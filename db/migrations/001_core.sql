-- Just Tennis analytics: core tables.
-- Everything lives in schema "jt", which Supabase does not expose through its public REST API.
-- Amounts are USD. Days are store days (America/Los_Angeles).

create schema if not exists jt;

-- ---------------------------------------------------------------- Shopify
-- Daily store totals exactly as Shopify Analytics reports them (FROM sales ... TIMESERIES day).
create table if not exists jt.shopify_daily (
  day            date primary key,
  orders         integer not null default 0,
  gross          numeric(12,2) not null default 0,
  discounts      numeric(12,2) not null default 0,
  returns        numeric(12,2) not null default 0,
  net            numeric(12,2) not null default 0,
  shipping       numeric(12,2) not null default 0,
  taxes          numeric(12,2) not null default 0,
  total          numeric(12,2) not null default 0,
  cogs           numeric(12,2) not null default 0,
  gross_profit   numeric(12,2) not null default 0,
  net_no_cost    numeric(12,2) not null default 0,   -- net sales with no cost recorded
  synced_at      timestamptz not null default now()
);

-- Sales facts from Shopify Analytics by day, order and variant. A return lands on the day it happened.
-- variant_id = 0 for custom items. The cost recorded here is the cost Shopify stored at the time of sale.
create table if not exists jt.shopify_sales (
  day            date   not null,
  order_id       bigint not null,
  order_name     text   not null default '',
  variant_id     bigint not null default 0,
  product_id     bigint not null default 0,
  product_title  text   not null default '',
  variant_title  text   not null default '',
  sku            text   not null default '',
  product_type   text   not null default '',
  vendor         text   not null default '',
  sales_channel  text   not null default '',
  units          numeric(12,2) not null default 0,
  gross          numeric(12,2) not null default 0,
  discounts      numeric(12,2) not null default 0,
  returns        numeric(12,2) not null default 0,
  net            numeric(12,2) not null default 0,
  cogs           numeric(12,2) not null default 0,
  net_no_cost    numeric(12,2) not null default 0,
  synced_at      timestamptz not null default now(),
  primary key (day, order_id, variant_id, product_title, sales_channel)
);
create index if not exists shopify_sales_order_idx on jt.shopify_sales (order_id);
create index if not exists shopify_sales_variant_idx on jt.shopify_sales (variant_id);

create table if not exists jt.shopify_orders (
  order_id           bigint primary key,
  name               text not null,
  created_at         timestamptz not null,
  order_day          date not null,
  source_name        text not null default '',
  channel            text not null default 'other',   -- web | pos | other
  financial_status   text not null default '',
  fulfillment_status text not null default '',
  cancelled_at       timestamptz,
  test               boolean not null default false,
  subtotal           numeric(12,2) not null default 0,
  discounts          numeric(12,2) not null default 0,
  shipping           numeric(12,2) not null default 0,
  tax                numeric(12,2) not null default 0,
  total              numeric(12,2) not null default 0,
  refunded           numeric(12,2) not null default 0,
  current_total      numeric(12,2) not null default 0,
  item_qty           integer not null default 0,
  updated_at         timestamptz,
  synced_at          timestamptz not null default now()
);
create unique index if not exists shopify_orders_name_idx on jt.shopify_orders (name);
create index if not exists shopify_orders_day_idx on jt.shopify_orders (order_day);

create table if not exists jt.shopify_order_lines (
  line_id          bigint primary key,
  order_id         bigint not null references jt.shopify_orders(order_id) on delete cascade,
  product_id       bigint,
  variant_id       bigint,
  title            text not null default '',
  variant_title    text not null default '',
  sku              text not null default '',
  quantity         integer not null default 0,
  current_quantity integer not null default 0,     -- after removals and returns
  unit_price       numeric(12,2) not null default 0 -- after all discounts
);
create index if not exists shopify_order_lines_order_idx on jt.shopify_order_lines (order_id);
create index if not exists shopify_order_lines_variant_idx on jt.shopify_order_lines (variant_id);

-- Full product catalog with today's cost (refreshed daily).
create table if not exists jt.variants (
  variant_id     bigint primary key,
  product_id     bigint not null,
  sku            text not null default '',
  product_title  text not null default '',
  variant_title  text not null default '',
  display_name   text not null default '',
  vendor         text not null default '',
  product_type   text not null default '',
  status         text not null default '',
  price          numeric(12,2),
  unit_cost      numeric(12,2),
  updated_at     timestamptz,
  seen_at        timestamptz not null default now()
);
create index if not exists variants_sku_idx on jt.variants (sku);
create index if not exists variants_product_idx on jt.variants (product_id);

-- Every change to a variant's cost, found by comparing catalog snapshots.
-- kind: null = decide by settings.cost_history_start; 'correction' = fix, applies to all history;
-- 'real' = the cost truly changed on that date, earlier sales keep the old cost.
create table if not exists jt.variant_cost_changes (
  id          bigserial primary key,
  changed_on  date   not null,
  variant_id  bigint not null,
  old_cost    numeric(12,2),
  new_cost    numeric(12,2),
  price       numeric(12,2),
  flag        text not null default '',
  kind        text check (kind in ('correction', 'real')),
  unique (changed_on, variant_id)
);

-- Product cost entered in the dashboard for orders Shopify sold without a cost.
-- cost = full product cost of the order; shopify_cogs = the Shopify cost it was built on,
-- so the amount added is cost - shopify_cogs. lines = {line_id: {unit, qty, title}}.
create table if not exists jt.cost_overrides (
  order_id      bigint primary key,
  order_name    text not null default '',
  cost          numeric(12,2) not null,
  shopify_cogs  numeric(12,2),
  lines         jsonb not null default '{}'::jsonb,
  src           text not null default '',
  note          text not null default '',
  updated_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------- ShipStation
create table if not exists jt.shipstation_labels (
  label_id     text primary key,
  tracking     text not null default '',
  order_id     bigint,               -- Shopify order id (from external_shipment_id)
  ship_date    date not null,
  service      text not null default '',
  cost         numeric(12,2) not null default 0,
  voided       boolean not null default false,
  created_at   timestamptz,
  synced_at    timestamptz not null default now()
);
create index if not exists shipstation_labels_order_idx on jt.shipstation_labels (order_id);
create index if not exists shipstation_labels_day_idx on jt.shipstation_labels (ship_date);

-- ---------------------------------------------------------------- Amazon
create table if not exists jt.amazon_listings (
  sku          text primary key,
  asin         text not null default '',
  title        text not null default '',
  price        numeric(12,2),
  quantity     integer,
  channel      text not null default '',     -- AMAZON_NA = FBA, DEFAULT = merchant
  status       text not null default '',
  open_date    date,
  report_file  text not null default '',
  uploaded_at  timestamptz not null default now()
);

-- Amazon listing -> Shopify variant (or a typed cost per Amazon unit).
create table if not exists jt.amazon_map (
  sku              text primary key,
  asin             text not null default '',
  kind             text not null check (kind in ('shopify', 'manual')),
  variant_id       bigint,
  product_id       bigint,
  vsku             text not null default '',
  vtitle           text not null default '',
  vendor           text not null default '',
  units            numeric(10,2) not null default 1,  -- Shopify units per Amazon unit
  manual_cost      numeric(12,2),
  unit_cost_at_map numeric(12,2),
  updated_at       timestamptz not null default now(),
  check (kind = 'manual' or variant_id is not null)
);

-- One row per line of the Seller Central "Date Range" (unified transaction) report.
create table if not exists jt.amazon_transactions (
  row_hash          text primary key,          -- md5 of the raw line, so re-uploads never double count
  posted_at         timestamp not null,        -- as printed in the report (Pacific)
  day               date not null,
  type              text not null,
  settlement_id     text not null default '',
  order_id          text not null default '',
  sku               text not null default '',
  description       text not null default '',
  quantity          integer not null default 0,
  fulfillment       text not null default '',
  product_sales     numeric(12,2) not null default 0,
  shipping_credits  numeric(12,2) not null default 0,
  gift_wrap_credits numeric(12,2) not null default 0,
  promo_rebates     numeric(12,2) not null default 0,
  selling_fees      numeric(12,2) not null default 0,
  fba_fees          numeric(12,2) not null default 0,
  other_fees        numeric(12,2) not null default 0,
  other             numeric(12,2) not null default 0,
  total             numeric(12,2) not null default 0,
  report_file       text not null default ''
);
create index if not exists amazon_transactions_day_idx on jt.amazon_transactions (day);
create index if not exists amazon_transactions_sku_idx on jt.amazon_transactions (sku);

-- ---------------------------------------------------------------- housekeeping
create table if not exists jt.settings (
  key         text primary key,
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);

create table if not exists jt.sync_runs (
  id           bigserial primary key,
  job          text not null,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  ok           boolean,
  rows         integer,
  detail       text not null default ''
);
create index if not exists sync_runs_job_idx on jt.sync_runs (job, started_at desc);
