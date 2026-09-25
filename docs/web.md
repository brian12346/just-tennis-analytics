# Web dashboard: dashboard.andersenlifestyle.com

The same page as the Claude artifact, served by Vercel from this repo. It detects where it runs:

| | Inside Claude | On the web |
|---|---|---|
| Sign-in | your claude.ai account | Supabase Auth (email + password), only accounts listed in `jt.app_users` |
| Database reads | Supabase connector (`execute_sql`) | `public.jt_sql(q)`: read-only (runs as role `jt_reader`), refuses anyone not in `jt.app_users` |
| Saves | connector | `public.jt_save_cost_overrides`, `jt_delete_cost_override`, `jt_doc_set`, `jt_doc_delete` |
| Amazon data, cost-check log | Claude page storage (copied to `jt.docs`) | `jt.docs` |
| Shopify product search / current cost (Amazon tabs) | `jt.variants` (nightly catalog sync) | same |

Nothing in schema `jt` is exposed through Supabase's API; the browser only holds the publishable key, which grants nothing
by itself. See `db/migrations/004_web_access.sql`.

## One-time setup

1. **Supabase login** — Authentication → Users → Add user → Create new user (your email, a password, *Auto Confirm User*).
   Then give it access: `insert into jt.app_users (user_id, email) select id, email from auth.users where email = '<you>';`
2. **Turn off sign-ups** — Authentication → Sign In / Providers → *Allow new users to sign up* off (Email provider stays on).
3. **Vercel** — vercel.com → Add New → Project → import `just-tennis-analytics` from GitHub. Leave the settings Vercel reads
   from `vercel.json` (build `node dashboard/build.mjs`, output `dashboard/dist/web`). Deploy.
4. **Domain** — Vercel project → Settings → Domains → add `dashboard.andersenlifestyle.com`. Vercel shows a CNAME record;
   add it in GoDaddy (Domain → DNS → Add record → CNAME, name `dashboard`, value from Vercel). HTTPS is automatic.

Every `git push` to `main` redeploys the site.

## Adding someone later
Create their user in Supabase (step 1) and insert their row into `jt.app_users`. Remove access by deleting that row.
