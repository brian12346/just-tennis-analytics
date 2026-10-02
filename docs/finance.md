# Finance dashboard (finance.andersenlifestyle.com)

A separate site from the sales dashboard, built from `finance/` in this repo. Same Supabase project and sign-in
accounts, but its own access list and its own data schema.

- **Access:** `fin.users` (user id + email). Being on `jt.app_users` (sales dashboard) does not give finance access.
  Add someone: `insert into fin.users (user_id, email) select id, email from auth.users where email = '…';`
- **Reads:** `public.fin_sql(q)` runs as `fin_reader` (schema `fin` + shared `jt` data, read-only) and only answers
  `fin.users`. The sales dashboard's `public.jt_sql` (runs as `jt_reader`) cannot read schema `fin`.
- **Payables data:** the `qbo` edge function, action `payables_sync`, copies QuickBooks vendors, bills, bill payments
  and vendor credits into `fin.qbo_*` (pg_cron `fin-qbo-payables` hourly at :35, see `db/supabase/finance_scheduler.sql`;
  only changes since the last pass, a full pass weekly). "Refresh from QuickBooks" on the page runs it now.
  Finance-only accounts may call the qbo function for `status` and `payables_sync` only.
- **Build:** `node finance/build.mjs` → `finance/dist/index.html` (src/index.html with its `@inline` files).

## Vercel setup (once)

1. Vercel → Add New → Project → import `brian12346/just-tennis-analytics` again.
2. **Root Directory: `finance`** (Vercel then uses `finance/vercel.json`: build `node build.mjs`, output `dist`).
   Framework preset: Other. Leave build/output settings to the vercel.json.
3. Deploy, then Settings → Domains → add `finance.andersenlifestyle.com` and add the DNS record Vercel shows
   (a CNAME to `cname.vercel-dns.com`) wherever andersenlifestyle.com's DNS is managed.

Both projects deploy on every push; each only uses its own folder.

## Cash flow page (`#cash`)

17 weeks from this week. In: Amazon payouts (Finances API "Transfer" postings, `fin.v_amazon_payouts`; each payout
stream = marketplace + weekday, every N weeks; estimate = the stream's payout share of sales this year × Amazon sales
(`jt.v_amazon_api_daily`) for the same pay period 364 days earlier × the "vs last year" % in `fin.settings` key
`amazon`; falls back to the average of its last 3), Shopify payouts (weekly on the day set on the page; each Sunday's
payouts summed per week from `fin.shopify_payouts`, average of the last 4 weeks, or a share of the last 4 weeks'
Shopify sales until those sync), other receipts typed in. Out: open QuickBooks bills by due date (overdue → this
week) and other payments typed in. Typed amounts live in `fin.forecast` (cleared ones are kept with `active = false`);
the starting balance and Shopify settings in `fin.settings`.

Shopify payouts: sync job `shopify-payouts` (hourly), needs the Shopify app scope `read_shopify_payments_accounts`;
without it the job skips quietly.

Starting cash: by default the QuickBooks balances of the bank accounts ticked on the page (`fin.qbo_accounts`,
refreshed by `payables_sync`; until something is ticked, checking/savings accounts over $100). Card balances are
listed for reference; "Add payment" turns one into an Other out line. Setting `fin.settings.cash`:
`{source: 'qbo' | 'typed', accounts: [ids], balance, as_of}`.
