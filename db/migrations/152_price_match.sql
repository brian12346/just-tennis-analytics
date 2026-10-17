-- Price match (Brian, Oct 17; spec "HANDOFF-seller-sage.md" from the jt-price-match package, Oct 16).
-- Every day, for each enabled brand: the brand's own website prices (by SKU) and the Amazon Buy Box (by UPC) are compared
-- with Just Tennis's Shopify prices. Where Just Tennis is higher, a lower price is proposed — never below the brand's
-- MAP, never below cost + a minimum margin — and a price this feature lowered is put back once the competitor's price
-- goes back up. Review mode (the default) queues the changes for approval on Sales › Price match; auto mode applies
-- them (drops over the max-drop % still wait for review). Every applied change can be rolled back.
--
-- Who does what:
--   * Supabase edge function "amazon", action "buybox" (pg_cron, early morning): UPC -> ASIN (cached) and the Buy Box
--     price per ASIN -> jt.pm_amazon_prices.
--   * Sync job "price-match" (GitHub Actions, dispatched daily 05:30 PT and by "Run now"): brand sites + Shopify +
--     the Amazon prices above -> jt.pm_runs / jt.pm_changes (and, in auto mode, Shopify).
--   * Sync job "price-match-apply" (dispatched when changes are approved or rolled back): approved / rollback rows ->
--     Shopify (productVariantsBulkUpdate).

-- brands: where their prices come from and which Just Tennis vendors they are
create table if not exists jt.pm_sources (
  name         text primary key,
  kind         text not null default 'shopify_site',     -- shopify_site | custom (needs an adapter)
  base_url     text not null default '',
  collections  text[] not null default array['all'],     -- 'all' = /products.json
  sku_prefix   integer not null default 0,               -- compare only the first N characters of the SKU (0 = whole SKU)
  vendors      text[] not null default '{}',
  enabled      boolean not null default true,
  sort         integer not null default 0,
  status       text not null default '',                 -- last run: ok | not covered | error
  last_error   text not null default '',
  last_count   integer,                                  -- brand SKUs read on the last run
  checked_at   timestamptz
);
insert into jt.pm_sources (name, base_url, collections, sku_prefix, vendors, sort) values
  ('Wilson', 'https://www.wilson.com/en-us', array['deals', 'tennis', 'pickleball', 'padel'], 9, array['Wilson', 'Luxilon'], 1),
  ('Selkirk', 'https://www.selkirk.com', array['all'], 0, array['Selkirk'], 2),
  ('Joola', 'https://www.joola.com', array['all'], 0, array['Joola'], 3),
  ('Holbrook', 'https://holbrookpickleball.com', array['all'], 0, array['Holbrook'], 4),
  ('Head', 'https://www.head.com/en_US', array['all'], 0, array['Head'], 5),
  ('Yonex', 'https://www.yonex.com', array['all'], 0, array['Yonex'], 6),
  ('Babolat', 'https://www.babolat.com/us', array['all'], 0, array['Babolat'], 7),
  ('K-Swiss', 'https://www.kswiss.com', array['all'], 11, array['K Swiss', 'K-Swiss'], 8),
  ('New Balance', 'https://www.newbalance.com', array['all'], 0, array['New Balance'], 9),
  ('Tecnifibre', 'https://www.tecnifibre.com', array['all'], 0, array['Tecnifibre'], 10),
  ('Dunlop', 'https://www.dunlopsports.com', array['all'], 0, array['Dunlop'], 11)
on conflict (name) do nothing;

-- MAP floors: never price below these (longest matching SKU prefix for the brand, latest effective_from <= today)
create table if not exists jt.pm_map_floors (
  id              bigserial primary key,
  brand           text not null,
  sku_prefix      text not null,
  map_price       numeric(12,2) not null check (map_price >= 0),
  effective_from  date not null default current_date,
  source          text not null default '',
  active          boolean not null default true,         -- false = taken off the list (kept for the record)
  added_at        timestamptz not null default now(),
  added_by        text not null default '',
  unique (brand, sku_prefix, effective_from)
);
insert into jt.pm_map_floors (brand, sku_prefix, map_price, effective_from, source) values
  ('K-Swiss', '04603-002-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04605-002-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94603-002-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94606-002-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94604-002-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04603-161-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04605-161-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04604-161-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94603-162-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94606-162-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94604-162-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04603-102-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94603-100-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04603-162-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04605-162-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04604-162-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94603-110-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94606-110-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94604-110-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94603-103-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04603-603-M', 140.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94603-672-M', 140.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99583-108-M', 140.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99583-603-M', 140.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04603-062-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94603-118-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '84603-152-M', 90.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '84603-009-M', 90.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '84603-190-M', 90.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09629-104-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99629-104-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06613-039-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96613-085-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06613-102-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96613-102-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '86613-102-M', 90.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06613-090-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06806-090-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96613-089-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96807-089-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06613-140-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06806-140-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96613-126-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96613-182-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96613-173-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96807-178-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06613-011-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06806-034-W', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06613-104-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96613-165-M', 130.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09071-038-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99071-996-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09071-102-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09071-031-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99071-091-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99071-118-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09071-109-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99072-118-M', 150.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04902-074-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04902-407-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94902-021-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94902-127-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04903-074-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04903-407-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94904-021-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94904-127-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96563-072-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '07291-410-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '97292-440-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06563-410-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96563-440-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '97292-503-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '07291-072-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06563-072-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96563-503-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '97292-258-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96563-258-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '97292-072-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '07291-082-W', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96563-036-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06563-472-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96563-661-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06563-082-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '06563-955-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '96563-171-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04437-111-M', 175.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04437-109-M', 175.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94437-181-M', 175.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04437-031-M', 175.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94437-019-M', 175.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04598-032-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94598-091-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04598-109-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94598-118-M', 115.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04405-047-M', 125.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94405-118-M', 125.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09483-155-M', 155.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09483-162-M', 155.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09485-162-M', 155.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09483-047-M', 155.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99484-110-M', 155.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '99484-023-M', 155.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '09805-064-M', 135.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04432-031-M', 180.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04432-109-M', 180.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04898-131-M', 110.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94898-177-M', 110.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04898-056-M', 110.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94898-072-M', 110.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04933-100-M', 110.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94933-188-M', 110.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04597-020-M', 135.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94597-503-M', 135.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '08900-148-M', 120.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '98900-160-M', 120.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '04436-021-M', 125.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)'),
  ('K-Swiss', '94436-160-M', 125.00, date '2026-10-28', 'K-Swiss MAP list 10/28/2026 (Protected rows)')
on conflict (brand, sku_prefix, effective_from) do nothing;

create table if not exists jt.pm_runs (
  id           bigserial primary key,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  mode         text not null default 'review',            -- dry | review | auto
  status       text not null default 'running',           -- running | done | failed
  summary      jsonb not null default '{}'::jsonb,        -- {sources: {name: {status, matched, lowered, restored, floored, error}}, amazon: {...}, totals: {...}}
  error        text not null default '',
  started_by   text not null default ''
);

create table if not exists jt.pm_changes (
  id                bigserial primary key,
  run_id            bigint not null references jt.pm_runs(id),
  product_id        bigint not null,
  variant_id        bigint not null,
  product_title     text not null default '',
  variant_title     text not null default '',
  sku               text not null default '',
  vendor            text not null default '',
  source            text not null,                         -- brand name or 'Amazon'
  competitor_price  numeric(12,2),
  competitor_list   numeric(12,2),
  competitor_ref    text not null default '',              -- ASIN, or the brand site's product title
  competitor_url    text not null default '',
  old_price         numeric(12,2) not null,
  old_compare_at    numeric(12,2),
  new_price         numeric(12,2) not null,
  new_compare_at    numeric(12,2),
  cost              numeric(12,2),
  map_price         numeric(12,2),
  reason            text not null check (reason in ('lower', 'restore')),
  floor_applied     text check (floor_applied in ('map', 'cost')),
  big_drop          boolean not null default false,        -- over the max-drop %: always waits for review
  status            text not null default 'proposed'
                    check (status in ('proposed', 'approved', 'applied', 'rejected', 'failed', 'superseded', 'rollback', 'rolled_back')),
  error             text not null default '',
  decided_by        text not null default '',
  decided_at        timestamptz,
  applied_at        timestamptz,
  rolled_back_at    timestamptz,
  created_at        timestamptz not null default now()
);
create index if not exists pm_changes_status on jt.pm_changes (status);
create index if not exists pm_changes_run on jt.pm_changes (run_id);
create index if not exists pm_changes_variant on jt.pm_changes (variant_id);

-- what this feature lowered, so it can put it back (one row per variant while it's lowered)
create table if not exists jt.pm_state (
  variant_id       bigint primary key,
  product_id       bigint not null,
  orig_price       numeric(12,2) not null,
  orig_compare_at  numeric(12,2),
  source           text not null,
  lowered_at       timestamptz not null default now(),
  change_id        bigint,
  active           boolean not null default true           -- false = restored / rolled back (row kept for the record)
);

-- Amazon: UPC -> ASIN (looked up once, rechecked monthly) and the Buy Box price per ASIN (daily)
create table if not exists jt.pm_upc_asin (
  upc         text primary key,
  asin        text not null default '',                   -- '' = not on Amazon
  title       text not null default '',
  checked_at  timestamptz not null default now()
);
create table if not exists jt.pm_amazon_prices (
  asin              text primary key,
  price             numeric(12,2),                         -- Buy Box landed price (New), or the lowest other new offer when we hold the Buy Box / there is none
  buybox_price      numeric(12,2),
  own_buybox        boolean not null default false,
  amazon_fulfilled  boolean not null default false,
  offers            integer,
  error             text not null default '',
  checked_at        timestamptz not null default now()
);

insert into jt.settings (key, value) values ('price_match', jsonb_build_object(
  'mode', 'review', 'amazon', true, 'amazon_rule', 'buybox', 'map_floor', true, 'cost_floor', true, 'min_margin', 5,
  'max_drop', 40, 'exclude_tags', jsonb_build_array('JTonly', 'no-price-match'), 'exclude_types', jsonb_build_array('Used', 'Service', 'Gift')))
on conflict (key) do nothing;

-- ---------------------------------------------------------------- Amazon side (edge function, service role only)
-- UPCs to price: Just Tennis active variants of enabled brands with a 12–14 digit barcode whose ASIN is unknown or a
-- month old (lookup), and ASINs not priced in the last 18 hours (pricing).
create or replace function public.jt_pm_amazon_todo(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n_upc int := coalesce((p->>'upcs')::int, 200); n_asin int := coalesce((p->>'asins')::int, 200); r jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with vend as (select lower(regexp_replace(v, '[^a-zA-Z]', '', 'g')) v from jt.pm_sources s, unnest(s.vendors) v where s.enabled),
  want as (
    select distinct btrim(x.barcode) upc from jt.variants x
    where x.status = 'ACTIVE' and btrim(coalesce(x.barcode, '')) ~ '^\d{12,14}$'
      and lower(regexp_replace(x.vendor, '[^a-zA-Z]', '', 'g')) in (select v from vend)
  )
  select jsonb_build_object(
    'upcs', coalesce((select jsonb_agg(w.upc) from (select w.upc from want w left join jt.pm_upc_asin u on u.upc = w.upc
                       where u.upc is null or u.checked_at < now() - interval '30 days' order by u.checked_at nulls first limit n_upc) w), '[]'::jsonb),
    'asins', coalesce((select jsonb_agg(a.asin) from (select distinct u.asin, a.checked_at from want w join jt.pm_upc_asin u on u.upc = w.upc
                        left join jt.pm_amazon_prices a on a.asin = u.asin
                        where u.asin <> '' and (a.asin is null or a.checked_at < now() - interval '18 hours') order by a.checked_at nulls first limit n_asin) a), '[]'::jsonb),
    'left_upcs', (select count(*) from want w left join jt.pm_upc_asin u on u.upc = w.upc where u.upc is null or u.checked_at < now() - interval '30 days'),
    'left_asins', (select count(distinct u.asin) from want w join jt.pm_upc_asin u on u.upc = w.upc left join jt.pm_amazon_prices a on a.asin = u.asin
                   where u.asin <> '' and (a.asin is null or a.checked_at < now() - interval '18 hours')))
  into r;
  return r;
end $$;

-- p = {upcs: [{upc, asin, title}], prices: [{asin, price, buybox_price, own_buybox, amazon_fulfilled, offers, error}]}
create or replace function public.jt_pm_amazon_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare nu int := 0; np int := 0;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into jt.pm_upc_asin (upc, asin, title, checked_at)
  select x->>'upc', coalesce(x->>'asin', ''), left(coalesce(x->>'title', ''), 300), now() from jsonb_array_elements(coalesce(p->'upcs', '[]')) x
  on conflict (upc) do update set asin = excluded.asin, title = excluded.title, checked_at = now();
  get diagnostics nu = row_count;
  insert into jt.pm_amazon_prices (asin, price, buybox_price, own_buybox, amazon_fulfilled, offers, error, checked_at)
  select x->>'asin', nullif(x->>'price', '')::numeric, nullif(x->>'buybox_price', '')::numeric, coalesce((x->>'own_buybox')::boolean, false),
         coalesce((x->>'amazon_fulfilled')::boolean, false), nullif(x->>'offers', '')::int, left(coalesce(x->>'error', ''), 300), now()
  from jsonb_array_elements(coalesce(p->'prices', '[]')) x
  on conflict (asin) do update set price = excluded.price, buybox_price = excluded.buybox_price, own_buybox = excluded.own_buybox,
    amazon_fulfilled = excluded.amazon_fulfilled, offers = excluded.offers, error = excluded.error, checked_at = now();
  get diagnostics np = row_count;
  return jsonb_build_object('upcs', nu, 'prices', np);
end $$;

-- ---------------------------------------------------------------- the page
-- p = {ids: [change ids], action: approve | reject | rollback | reopen, by}
--   approve: proposed -> approved (the apply job writes them to Shopify)
--   reject:  proposed -> rejected
--   rollback: applied -> rollback (the apply job puts the old price back)
--   reopen:  rejected -> proposed
-- p = {run_id, action: 'rollback_run'} rolls back every applied change of that run.
create or replace function jt.pm_decide(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare act text := p->>'action'; who text := coalesce(p->>'by', ''); n int := 0; ids bigint[];
begin
  if act = 'rollback_run' then
    select array_agg(id) into ids from jt.pm_changes where run_id = (p->>'run_id')::bigint and status = 'applied';
    act := 'rollback';
  else
    select array_agg(x::bigint) into ids from jsonb_array_elements_text(coalesce(p->'ids', '[]')) x;
  end if;
  if ids is null then return jsonb_build_object('changed', 0); end if;
  if act = 'approve' then
    update jt.pm_changes set status = 'approved', decided_by = who, decided_at = now(), error = '' where id = any(ids) and status in ('proposed', 'failed');
  elsif act = 'reject' then
    update jt.pm_changes set status = 'rejected', decided_by = who, decided_at = now() where id = any(ids) and status in ('proposed', 'failed', 'approved');
  elsif act = 'reopen' then
    update jt.pm_changes set status = 'proposed', decided_by = '', decided_at = null where id = any(ids) and status = 'rejected';
  elsif act = 'rollback' then
    update jt.pm_changes set status = 'rollback', decided_by = who, decided_at = now(), error = '' where id = any(ids) and status = 'applied';
  else
    raise exception 'unknown action %', act;
  end if;
  get diagnostics n = row_count;
  if n > 0 and act in ('approve', 'rollback') and to_regprocedure('jt.dispatch_sync(text)') is not null then
    perform jt.dispatch_sync('price-match-apply');
  end if;
  return jsonb_build_object('changed', n, 'applying', n > 0 and act in ('approve', 'rollback'));
end $$;

-- p = settings fields to change (mode, amazon, map_floor, cost_floor, min_margin, max_drop, exclude_tags, exclude_types),
-- or {source: name, enabled: bool}
create or replace function jt.pm_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare cur jsonb := coalesce((select value from jt.settings where key = 'price_match'), '{}'::jsonb); k text;
begin
  if p ? 'source' then
    update jt.pm_sources set enabled = coalesce((p->>'enabled')::boolean, enabled) where name = p->>'source';
    return jsonb_build_object('source', p->>'source', 'enabled', (select enabled from jt.pm_sources where name = p->>'source'));
  end if;
  if p ? 'mode' and p->>'mode' not in ('review', 'auto') then raise exception 'mode must be review or auto'; end if;
  if p ? 'min_margin' and ((p->>'min_margin')::numeric < 0 or (p->>'min_margin')::numeric > 90) then raise exception 'min margin must be 0–90%%'; end if;
  if p ? 'max_drop' and ((p->>'max_drop')::numeric <= 0 or (p->>'max_drop')::numeric > 90) then raise exception 'max drop must be 1–90%%'; end if;
  for k in select jsonb_object_keys(p) loop
    if k in ('mode', 'amazon', 'map_floor', 'cost_floor', 'min_margin', 'max_drop', 'exclude_tags', 'exclude_types') then cur := cur || jsonb_build_object(k, p->k); end if;
  end loop;
  insert into jt.settings (key, value, updated_at) values ('price_match', cur, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
  return cur;
end $$;

-- MAP floors: p = {rows: [{brand, sku_prefix, map_price, effective_from}], source, by}  (CSV import / add one)
--             p = {off: [ids], by}   (take rows off the list)
create or replace function jt.pm_map_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int := 0; x jsonb; bad int := 0;
begin
  if p ? 'off' then
    update jt.pm_map_floors set active = false where id in (select v::bigint from jsonb_array_elements_text(p->'off') v);
    get diagnostics n = row_count;
    return jsonb_build_object('off', n);
  end if;
  for x in select * from jsonb_array_elements(coalesce(p->'rows', '[]')) loop
    if btrim(coalesce(x->>'brand', '')) = '' or btrim(coalesce(x->>'sku_prefix', '')) = '' or nullif(x->>'map_price', '') is null
       or (x->>'map_price') !~ '^\s*\$?\d+(\.\d+)?\s*$' then bad := bad + 1; continue; end if;
    insert into jt.pm_map_floors (brand, sku_prefix, map_price, effective_from, source, added_by, active)
    values (btrim(x->>'brand'), upper(btrim(x->>'sku_prefix')), replace(btrim(x->>'map_price'), '$', '')::numeric,
            coalesce(nullif(x->>'effective_from', '')::date, current_date), coalesce(p->>'source', 'Seller Sage'), coalesce(p->>'by', ''), true)
    on conflict (brand, sku_prefix, effective_from) do update set map_price = excluded.map_price, source = excluded.source, added_by = excluded.added_by, active = true;
    n := n + 1;
  end loop;
  return jsonb_build_object('saved', n, 'skipped', bad);
end $$;

-- "Run now": a preview run (review mode: proposes, changes nothing in Shopify)
create or replace function jt.pm_run_now() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from jt.pm_runs where status = 'running' and started_at > now() - interval '40 minutes') then
    return jsonb_build_object('already', true);
  end if;
  if to_regprocedure('jt.dispatch_sync(text)') is null then raise exception 'the sync dispatcher is not set up'; end if;
  perform jt.dispatch_sync('price-match');
  return jsonb_build_object('requested', true);
end $$;

-- app wrappers (refused unless the signed-in user is an app user)
create or replace function public.jt_pm_decide(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.pm_decide(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_pm_settings_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.pm_settings_save(p);
end $$;
create or replace function public.jt_pm_map_save(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.pm_map_save(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_pm_run_now() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.pm_run_now();
end $$;
grant execute on function public.jt_pm_decide(jsonb), public.jt_pm_settings_save(jsonb), public.jt_pm_map_save(jsonb), public.jt_pm_run_now() to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.pm_sources, jt.pm_map_floors, jt.pm_runs, jt.pm_changes, jt.pm_state, jt.pm_upc_asin, jt.pm_amazon_prices to jt_reader;
  end if;
end $$;

-- the "pm-amazon" edge function (Amazon Buy Box prices), called from pg_cron like jt.amazon_call
create or replace function jt.pm_amazon_call(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/pm-amazon', body := p, timeout_milliseconds := 120000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $$;
revoke all on function jt.pm_amazon_call(jsonb) from public;
