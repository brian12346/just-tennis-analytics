-- In-store pickup orders (Brian, Oct 6): no shipping label is bought, so the Just Tennis tab counts them as a $0
-- label instead of "No label · enter". Set by the sync (job shopify-pickups, hourly) from Shopify's
-- delivery_method:pick-up order search.
alter table jt.shopify_orders add column if not exists pickup boolean not null default false;
alter table jt.anr_orders add column if not exists pickup boolean not null default false;
