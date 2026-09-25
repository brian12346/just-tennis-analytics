# Data model (schema `jt`)

## Tables

| Table | Grain | Filled by |
|---|---|---|
| `shopify_daily` | day | Shopify Analytics daily totals (exactly what Shopify reports) |
| `shopify_sales` | day × order × variant × channel | Shopify Analytics. Returns land on the return day. `cogs` is the cost Shopify recorded at the time of sale; `net_no_cost` is sales with no cost recorded. `variant_id = 0` means custom item. |
| `shopify_orders`, `shopify_order_lines` | order, line item | Admin API (orders changed since the last run) |
| `variants` | variant | Nightly full catalog snapshot, with today's cost |
| `variant_cost_changes` | day × variant | Nightly: every cost that changed since the previous snapshot |
| `cost_overrides` | order | Costs typed in the dashboard's cost-mapping tab |
| `shipstation_labels` | label | ShipStation API; `order_id` is the Shopify order id |
| `amazon_transactions` | report line | Seller Central Date Range report (re-uploading the same file adds nothing) |
| `amazon_listings`, `amazon_map` | Amazon SKU | All Listings report; mapping to Shopify variants from the dashboard |
| `settings`, `sync_runs` | — | Cost settings; one row per sync job run |

## Views the dashboard reads

| View | Use |
|---|---|
| `v_daily` | Shopify tab: daily totals with entered costs applied, label cost, profit after shipping |
| `v_order_profit` | Shopify tab orders table |
| `v_product_sales_daily` | Product sales tab (sum over the chosen dates) |
| `v_costmap_orders`, `v_costmap_lines` | Cost-mapping tab: orders still missing a cost and the lines to fill |
| `v_amazon_daily`, `v_amazon_lines` | Amazon tab, with product cost from the mapping |
| `v_sync_status` | Last run of each sync job |

## Cost rules

**Entered costs** (`cost_overrides`): `cost` is the order's full product cost; `shopify_cogs` is the Shopify
cost it was built on, so the amount added is `cost - shopify_cogs`. That amount is spread across the order's
no-cost sales rows in proportion, on the day Shopify recorded each row, so a later return takes its share back.
An order whose no-cost items were all returned nets to zero and is not flagged.

**Cost history** (`variant_cost_on(variant, day)`): today's Shopify cost applies to all history, except where a
change counts as *real*; then sales before the change keep the old cost. A change is real when its `kind` is
`'real'`, or when `kind` is empty and it was made on/after `settings.costs.history_start` (earlier edits were
corrections while costs were being cleaned up). Changes take effect the day after they were detected.
