-- Operational alerts: things in the business that need someone to act (late shipments, stock problems; price rules
-- come next). Each rule is a query in jt.alert_candidates(); jt.refresh_alerts() runs them (pg_cron every 15
-- minutes, and "Check now" on the Alerts tab) and keeps jt.alerts current:
--   new condition            -> alert 'open' (owner = the rule's default owner)
--   still there              -> last_seen and the details refreshed
--   gone                     -> 'cleared' (resolved on its own)
--   person resolves it       -> 'resolved' with what was done and why it happened; while the condition stays, no new
--                               alert; if it comes back after clearing, that's a new alert (a repeat)
--   snoozed                  -> back to 'open' when the snooze ends, if still there
-- Severity: critical | warning | info. link says where the page sends you to fix it.

create table if not exists jt.alert_rules (
  code        text primary key,
  category    text not null,              -- shipping | inventory | price
  title       text not null,
  description text not null default '',
  action      text not null default '',   -- what to do about it
  owner       text not null default '',
  enabled     boolean not null default true,
  params      jsonb not null default '{}'::jsonb,
  sort        integer not null default 100,
  updated_at  timestamptz not null default now()
);

create table if not exists jt.alerts (
  id            bigserial primary key,
  rule          text not null references jt.alert_rules(code),
  key           text not null,             -- what it's about: an order id, a SKU, a variant id, or 'all' for summaries
  title         text not null,
  detail        text not null default '',
  severity      text not null default 'warning',
  link          jsonb not null default '{}'::jsonb,
  data          jsonb not null default '{}'::jsonb,
  status        text not null default 'open',   -- open | acked | snoozed | resolved | cleared
  owner         text not null default '',
  first_seen    timestamptz not null default now(),
  last_seen     timestamptz not null default now(),
  acked_at      timestamptz,
  acked_by      text not null default '',
  snoozed_until timestamptz,
  resolved_at   timestamptz,
  resolved_by   text not null default '',
  resolution    text not null default '',  -- what was done
  cause         text not null default ''   -- why it happened (a short list, for the patterns view)
);
create unique index if not exists alerts_live on jt.alerts (rule, key) where status in ('open', 'acked', 'snoozed');
create index if not exists alerts_rule_key on jt.alerts (rule, key, last_seen desc);
create index if not exists alerts_status on jt.alerts (status);

insert into jt.alert_rules (code, category, title, description, action, params, sort) values
  ('amazon_fbm_late', 'shipping', 'Amazon FBM order not shipped',
   'A merchant-fulfilled Amazon order is still unshipped. Late shipments count against the account''s late shipment rate.',
   'Ship it today, or confirm shipment in Seller Central if it already went out.', '{"warn_hours": 24, "crit_hours": 48}', 10),
  ('shopify_unfulfilled', 'shipping', 'Shopify order not fulfilled',
   'A paid web order hasn''t been fulfilled.', 'Ship it, or contact the customer if something is holding it up.',
   '{"warn_days": 2, "crit_days": 4}', 20),
  ('po_overdue', 'shipping', 'Purchase order past its expected date',
   'An open purchase order hasn''t been fully received by its expected date.',
   'Check with the vendor and update the expected date, or receive what arrived.', '{"grace_days": 0, "crit_days": 7}', 30),
  ('fbm_oversell', 'inventory', 'Amazon shows more than we have',
   'An active FBM listing''s quantity on Amazon is more than the FBM location''s Shopify stock covers, so Amazon can sell stock we don''t have.',
   'Lower the quantity on Amazon (FBM stock tab) or fix the Shopify count.', '{}', 40),
  ('fbm_not_taken_out', 'inventory', 'Shipped FBM orders still in Shopify stock',
   'Shipped Amazon FBM orders haven''t been taken out of Shopify yet, so Shopify''s stock is too high.',
   'Confirm them on the FBM stock tab.', '{"hours": 24}', 50),
  ('fbm_sync_failed', 'inventory', 'Stock change didn''t go through',
   'Shopify refused an FBM take-out, or Amazon refused a quantity we sent.', 'Open it, read the reason, and retry or fix the listing.', '{}', 55),
  ('out_of_stock_selling', 'inventory', 'Out of stock on a product that sells',
   'A tracked Shopify product is at 0 (or below) and sold recently (Shopify + Amazon FBM, last 30 days).',
   'Reorder, or mark it inactive if it''s discontinued.', '{"min_units_30d": 4, "crit_units_30d": 10}', 60),
  ('low_cover', 'inventory', 'Running low',
   'Stock covers fewer days than the threshold at the last 30 days'' sales pace (Shopify + Amazon FBM).',
   'Reorder or move stock from the other location.', '{"days": 14, "crit_days": 7, "min_units_30d": 3}', 70),
  ('negative_stock', 'inventory', 'Negative stock in Shopify',
   'Shopify shows less than zero available — something sold that wasn''t counted in, or a count is wrong.',
   'Count it and correct the quantity in Shopify.', '{}', 80),
  ('fbm_unmapped_listed', 'inventory', 'FBM listings we can''t check',
   'FBM listings with quantity on Amazon that aren''t mapped to a Shopify product, so oversells can''t be caught.',
   'Map them on Amazon mapping.', '{}', 90),
  ('fbm_idle_stock', 'inventory', 'Stock not listed on Amazon',
   'FBM listings with stock at the FBM location but 0 on Amazon.', 'Send quantities from the FBM stock tab (0 on Amazon filter).', '{}', 95)
on conflict (code) do nothing;

-- The rules. One row per thing to alert on.
create or replace function jt.alert_candidates()
returns table (rule text, key text, title text, detail text, severity text, link jsonb, data jsonb)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  p jsonb;
  loc text := (select value->>'location_id' from jt.settings where key = 'fbm_sync');
  synced boolean := exists (select 1 from jt.location_stock s where s.location_id = loc);
begin
  -- ---------- shipping
  p := (select r.params from jt.alert_rules r where r.code = 'amazon_fbm_late');
  return query
    select 'amazon_fbm_late', l.order_id,
           format('Amazon %s order unshipped for %s h', upper(min(l.marketplace)), floor(extract(epoch from now() - min(l.purchase_at)) / 3600)::int),
           string_agg(format('%s × %s', l.quantity, coalesce(nullif(l.product_name, ''), l.sku)), '; ' order by l.sku),
           case when min(l.purchase_at) < now() - make_interval(hours => coalesce((p->>'crit_hours')::int, 48)) then 'critical' else 'warning' end,
           jsonb_build_object('url', 'https://sellercentral.amazon.com/orders-v3/order/' || l.order_id),
           jsonb_build_object('purchased', min(l.purchase_at), 'skus', jsonb_agg(l.sku))
    from (select * from jt.amazon_order_lines l0 where l0.purchase_at > now() - interval '30 days' offset 0) l   -- recent lines first
    where l.fulfillment = 'Merchant' and l.item_status = 'Unshipped' and l.order_status not in ('Cancelled')
      and l.purchase_at < now() - make_interval(hours => coalesce((p->>'warn_hours')::int, 24))
    group by l.order_id;

  p := (select r.params from jt.alert_rules r where r.code = 'shopify_unfulfilled');
  return query
    select 'shopify_unfulfilled', o.order_id::text,
           format('Shopify order %s not fulfilled after %s days', o.name, floor(extract(epoch from now() - o.created_at) / 86400)::int),
           format('%s item%s · $%s · %s', o.item_qty, case when o.item_qty = 1 then '' else 's' end, to_char(o.total, 'FM999,990.00'), initcap(lower(o.financial_status))),
           case when o.created_at < now() - make_interval(days => coalesce((p->>'crit_days')::int, 4)) then 'critical' else 'warning' end,
           jsonb_build_object('url', 'https://admin.shopify.com/store/justtennis-822/orders/' || o.order_id),
           jsonb_build_object('created', o.created_at, 'name', o.name)
    from jt.shopify_orders o
    where o.cancelled_at is null and not coalesce(o.test, false)
      and o.fulfillment_status in ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'ON_HOLD')
      and o.financial_status in ('PAID', 'PARTIALLY_PAID', 'AUTHORIZED', 'PARTIALLY_REFUNDED')
      and coalesce(o.channel, '') not in ('pos')
      and o.created_at < now() - make_interval(days => coalesce((p->>'warn_days')::int, 2))
      and o.created_at > now() - interval '60 days';

  p := (select r.params from jt.alert_rules r where r.code = 'po_overdue');
  return query
    select 'po_overdue', po.id::text,
           format('%s PO %s is %s day%s late', po.vendor, coalesce(nullif(po.po_no, ''), '#' || po.id),
                  current_date - po.expected_on, case when current_date - po.expected_on = 1 then '' else 's' end),
           format('Expected %s · %s', to_char(po.expected_on, 'Mon DD'), case po.status when 'partial' then 'partly received' else po.status end),
           case when current_date - po.expected_on > coalesce((p->>'crit_days')::int, 7) then 'critical' else 'warning' end,
           jsonb_build_object('tab', 'po', 'id', po.id),
           jsonb_build_object('expected_on', po.expected_on, 'vendor', po.vendor)
    from jt.prep_orders po
    where po.status in ('ordered', 'invoiced', 'partial') and po.expected_on is not null
      and po.expected_on < current_date - coalesce((p->>'grace_days')::int, 0);

  -- ---------- inventory: FBM listings against FBM location stock
  return query
    with lst as (
      select r->>0 as sku, coalesce(r->>1, '') as asin, coalesce(r->>2, '') as ltitle, nullif(r->>4, '')::int as q, r->>6 as st,
             (d.data->>'uploadedAt')::timestamptz as report_at
      from jt.docs d, jsonb_array_elements(d.data->'rows') r
      where d.collection = 'amzlistings' and r->>5 = 'DEFAULT'
    ),
    maps as materialized (
      select m.data->>'sku' as sku, m.data->>'kind' as kind,
             nullif(regexp_replace(coalesce(m.data->>'variantId', ''), '^.*/', ''), '')::bigint as vid,
             greatest(coalesce(nullif(m.data->>'units', '')::numeric, 1), 1) as mu
      from jt.docs m where m.collection = 'amzmap'
    ),
    pushed as (select distinct on (f.sku) f.sku, f.quantity, f.status, f.requested_at from jt.fbm_pushes f where not f.preview order by f.sku, f.requested_at desc),
    x as (
      select l.*, m.kind, m.mu, v.variant_id, v.product_id, v.display_name,
             case when pu.status = 'ACCEPTED' and (l.report_at is null or pu.requested_at > l.report_at) then pu.quantity else l.q end as qnow,
             floor(greatest(case when synced then coalesce(ls.available, 0) else v.inventory_qty end, 0) / m.mu)::int as covers
      from lst l
      left join maps m on m.sku = l.sku
      left join jt.variants v on v.variant_id = m.vid and m.kind = 'shopify'
      left join jt.location_stock ls on ls.location_id = loc and ls.inventory_item_id = v.inventory_item_id
      left join pushed pu on pu.sku = l.sku
    )
    select 'fbm_oversell', x.sku,
           format('Amazon shows %s, stock covers %s', x.qnow, x.covers),
           format('%s (%s) → %s', x.ltitle, x.asin, x.display_name),
           case when x.covers = 0 then 'critical' else 'warning' end,
           jsonb_build_object('tab', 'fbm', 'q', x.sku),
           jsonb_build_object('asin', x.asin, 'amazon_qty', x.qnow, 'covers', x.covers, 'variant_id', x.variant_id, 'product_id', x.product_id)
    from x where x.st = 'Active' and x.variant_id is not null and coalesce(x.qnow, 0) > x.covers
    union all
    select 'fbm_unmapped_listed', 'all',
           format('%s FBM listings with quantity on Amazon aren''t mapped', count(*)),
           'Their stock can''t be checked against Shopify.', 'info',
           jsonb_build_object('tab', 'amzmap', 'skus', jsonb_agg(x.sku order by x.sku)),
           jsonb_build_object('count', count(*))
    from x where coalesce(x.qnow, 0) > 0 and x.kind is null
    having count(*) > 0
    union all
    select 'fbm_idle_stock', 'all',
           format('%s FBM listings have stock but 0 on Amazon', count(*)),
           format('%s units of Amazon quantity could be listed.', sum(x.covers)), 'info',
           jsonb_build_object('tab', 'fbm', 'filter', 'zero'),
           jsonb_build_object('count', count(*), 'units', sum(x.covers))
    from x where x.variant_id is not null and x.covers > 0 and coalesce(x.qnow, 0) = 0
    having count(*) > 0;

  p := (select r.params from jt.alert_rules r where r.code = 'fbm_not_taken_out');
  return query
    select 'fbm_not_taken_out', 'all',
           format('%s shipped FBM order%s not taken out of Shopify', count(distinct f.order_id), case when count(distinct f.order_id) = 1 then '' else 's' end),
           format('%s Shopify units; oldest from %s', coalesce(sum(f.units), 0), to_char(min(f.purchase_at) at time zone 'America/Los_Angeles', 'Mon DD')),
           case when min(f.purchase_at) < now() - interval '3 days' then 'warning' else 'info' end,
           jsonb_build_object('tab', 'fbm'),
           jsonb_build_object('orders', count(distinct f.order_id), 'units', coalesce(sum(f.units), 0))
    from jt.v_fbm_lines f
    where f.shipped and not f.cancelled and f.units is not null and (f.status is null or f.status = 'undone')
      and f.purchase_at < now() - make_interval(hours => coalesce((p->>'hours')::int, 24))
    having count(*) > 0;

  return query
    select 'fbm_sync_failed', 'shopify:' || d.order_id || ':' || d.sku,
           format('Shopify didn''t take FBM order %s', d.order_id), d.error, 'warning',
           jsonb_build_object('tab', 'fbm'), jsonb_build_object('order_id', d.order_id, 'sku', d.sku)
    from jt.fbm_decisions d where d.status = 'failed'
    union all
    select 'fbm_sync_failed', 'amazon:' || pu.sku,
           format('Amazon refused quantity %s for %s', pu.quantity, pu.sku),
           coalesce(nullif(pu.error, ''), 'Amazon said ' || pu.status), 'warning',
           jsonb_build_object('tab', 'fbm', 'q', pu.sku), jsonb_build_object('sku', pu.sku, 'asin', pu.asin)
    from (select distinct on (f.sku) f.* from jt.fbm_pushes f where not f.preview order by f.sku, f.requested_at desc) pu
    where pu.status <> 'ACCEPTED' and pu.requested_at > now() - interval '14 days';

  -- ---------- inventory: Shopify stock against sales pace
  return query
    with sh as (select s.variant_id, sum(s.units) as u from jt.shopify_sales s where s.day >= current_date - 30 and s.variant_id is not null group by 1),
    maps as (
      select m.data->>'sku' as sku, nullif(regexp_replace(coalesce(m.data->>'variantId', ''), '^.*/', ''), '')::bigint as vid,
             greatest(coalesce(nullif(m.data->>'units', '')::numeric, 1), 1) as mu
      from jt.docs m where m.collection = 'amzmap' and m.data->>'kind' = 'shopify'
    ),
    fl as materialized (   -- FBM units by seller SKU, last 30 days (filtered first: joining every mapping to the lines is slow)
      select l.sku, sum(l.quantity) as q from jt.amazon_order_lines l
      where l.purchase_at >= now() - interval '30 days' and l.fulfillment = 'Merchant' and l.order_status <> 'Cancelled' group by 1
    ),
    fbm as (select m.vid as variant_id, sum(fl.q * m.mu) as u from fl join maps m on m.sku = fl.sku group by 1),
    v as (
      select v.variant_id, v.product_id, v.display_name, v.sku, v.inventory_qty as q, (coalesce(sh.u, 0) + coalesce(fbm.u, 0))::numeric as u
      from jt.variants v left join sh on sh.variant_id = v.variant_id left join fbm on fbm.variant_id = v.variant_id
      where v.removed_at is null and coalesce(v.tracked, true) and coalesce(nullif(v.status, ''), 'ACTIVE') ilike 'active'
    ),
    po as (   -- units on open POs, so "reorder" alerts say if something's already coming
      select pl.variant_id, sum(greatest(coalesce(pl.qty_ordered, 0) - coalesce(pl.qty_received, 0), 0)) as incoming
      from jt.prep_order_lines pl join jt.prep_orders o on o.id = pl.order_id
      where o.status in ('ordered', 'invoiced', 'partial') group by 1
    ),
    pr as (
      select (select r.params from jt.alert_rules r where r.code = 'out_of_stock_selling') as oos,
             (select r.params from jt.alert_rules r where r.code = 'low_cover') as low
    )
    select 'out_of_stock_selling', v.variant_id::text,
           format('Out of stock: %s', v.display_name),
           format('%s sold in 30 days · Shopify shows %s%s', v.u::int, v.q, case when po.incoming > 0 then format(' · %s on open POs', po.incoming) else '' end),
           case when v.u >= coalesce((pr.oos->>'crit_units_30d')::int, 10) and coalesce(po.incoming, 0) = 0 then 'critical' else 'warning' end,
           jsonb_build_object('shopify', jsonb_build_object('product_id', v.product_id, 'variant_id', v.variant_id)),
           jsonb_build_object('sku', v.sku, 'units_30d', v.u, 'qty', v.q, 'incoming', coalesce(po.incoming, 0))
    from v cross join pr left join po on po.variant_id = v.variant_id
    where v.q <= 0 and v.u >= coalesce((pr.oos->>'min_units_30d')::int, 4)
    union all
    select 'low_cover', v.variant_id::text,
           format('%s days left: %s', floor(v.q * 30 / v.u)::int, v.display_name),
           format('%s in stock · %s sold in 30 days%s', v.q, v.u::int, case when po.incoming > 0 then format(' · %s on open POs', po.incoming) else '' end),
           case when v.q * 30 / v.u < coalesce((pr.low->>'crit_days')::int, 7) and coalesce(po.incoming, 0) = 0 then 'warning' else 'info' end,
           jsonb_build_object('shopify', jsonb_build_object('product_id', v.product_id, 'variant_id', v.variant_id)),
           jsonb_build_object('sku', v.sku, 'units_30d', v.u, 'qty', v.q, 'days', round(v.q * 30 / v.u, 1), 'incoming', coalesce(po.incoming, 0))
    from v cross join pr left join po on po.variant_id = v.variant_id
    where v.q > 0 and v.u >= coalesce((pr.low->>'min_units_30d')::int, 3) and v.q * 30 / v.u < coalesce((pr.low->>'days')::int, 14)
    union all
    select 'negative_stock', v.variant_id::text,
           format('Negative stock: %s', v.display_name), format('Shopify shows %s', v.q), 'warning',
           jsonb_build_object('shopify', jsonb_build_object('product_id', v.product_id, 'variant_id', v.variant_id)),
           jsonb_build_object('sku', v.sku, 'qty', v.q)
    from v cross join pr where v.q < 0 and v.u < coalesce((pr.oos->>'min_units_30d')::int, 4);   -- selling ones are under out_of_stock_selling
end $$;

-- run the rules and update jt.alerts; returns {new, updated, cleared}
create or replace function jt.refresh_alerts() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n_new int; n_upd int; n_clr int; n_wake int; cj jsonb;
begin
  cj := coalesce((select jsonb_agg(to_jsonb(c)) from jt.alert_candidates() c join jt.alert_rules r on r.code = c.rule and r.enabled), '[]'::jsonb);
  -- snoozes that have ended
  update jt.alerts set status = 'open', snoozed_until = null where status = 'snoozed' and snoozed_until <= now();
  get diagnostics n_wake = row_count;
  -- still there: refresh. A resolved alert whose condition never went away stays resolved (seen in the last hour).
  update jt.alerts a set last_seen = now(), title = c.title, detail = c.detail, severity = c.severity, link = c.link, data = c.data
  from jsonb_to_recordset(cj) as c(rule text, key text, title text, detail text, severity text, link jsonb, data jsonb)
  where a.rule = c.rule and a.key = c.key
    and (a.status in ('open', 'acked', 'snoozed') or (a.status = 'resolved' and a.last_seen > now() - interval '1 hour'));
  get diagnostics n_upd = row_count;
  -- new (or back after it cleared)
  insert into jt.alerts (rule, key, title, detail, severity, link, data, owner)
  select c.rule, c.key, c.title, c.detail, c.severity, c.link, c.data, r.owner
  from jsonb_to_recordset(cj) as c(rule text, key text, title text, detail text, severity text, link jsonb, data jsonb)
  join jt.alert_rules r on r.code = c.rule
  where not exists (select 1 from jt.alerts a where a.rule = c.rule and a.key = c.key
                      and (a.status in ('open', 'acked', 'snoozed') or (a.status = 'resolved' and a.last_seen > now() - interval '1 hour')));
  get diagnostics n_new = row_count;
  -- gone
  update jt.alerts a set status = 'cleared', resolved_at = now(), resolution = 'Cleared on its own'
  where a.status in ('open', 'acked', 'snoozed') and a.last_seen < now() - interval '1 minute'
    and not exists (select 1 from jsonb_to_recordset(cj) as c(rule text, key text) where c.rule = a.rule and c.key = a.key);
  get diagnostics n_clr = row_count;
  insert into jt.settings (key, value) values ('alerts', jsonb_build_object('checked_at', now()))
  on conflict (key) do update set value = jt.settings.value || jsonb_build_object('checked_at', now()), updated_at = now();
  return jsonb_build_object('new', n_new, 'updated', n_upd, 'cleared', n_clr, 'reopened', n_wake);
end $$;

-- p = {ids: [..], action: 'ack' | 'snooze' | 'resolve' | 'reopen' | 'assign', until, resolution, cause, owner, by}
create or replace function jt.alert_act(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int; who text := coalesce(nullif(p->>'by', ''), 'dashboard'); a text := p->>'action';
begin
  if a = 'resolve' and coalesce(btrim(p->>'resolution'), '') = '' then raise exception 'say what was done'; end if;
  update jt.alerts set
    status = case a when 'ack' then 'acked' when 'snooze' then 'snoozed' when 'resolve' then 'resolved' when 'reopen' then 'open' else status end,
    acked_at = case when a = 'ack' then now() else acked_at end,
    acked_by = case when a = 'ack' then who else acked_by end,
    snoozed_until = case when a = 'snooze' then coalesce((p->>'until')::timestamptz, now() + interval '1 day') when a in ('reopen', 'resolve') then null else snoozed_until end,
    resolved_at = case when a = 'resolve' then now() when a = 'reopen' then null else resolved_at end,
    resolved_by = case when a = 'resolve' then who when a = 'reopen' then '' else resolved_by end,
    resolution = case when a = 'resolve' then btrim(p->>'resolution') when a = 'reopen' then '' else resolution end,
    cause = case when a = 'resolve' then coalesce(p->>'cause', '') when a = 'reopen' then '' else cause end,
    owner = case when a = 'assign' or (p ? 'owner') then coalesce(p->>'owner', '') else owner end
  where id in (select (jsonb_array_elements_text(p->'ids'))::bigint)
    and (a <> 'reopen' or status in ('resolved', 'cleared', 'snoozed', 'acked'));
  get diagnostics n = row_count;
  if a not in ('ack', 'snooze', 'resolve', 'reopen', 'assign') then raise exception 'unknown action %', a; end if;
  return n;
end $$;

-- p = {code, owner?, enabled?, params?}
create or replace function jt.alert_rule_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jsonb;
begin
  update jt.alert_rules set
    owner = coalesce(p->>'owner', owner),
    enabled = coalesce((p->>'enabled')::boolean, enabled),
    params = case when p ? 'params' then params || (p->'params') else params end,
    updated_at = now()
  where code = p->>'code'
  returning to_jsonb(jt.alert_rules.*) into r;
  if r is null then raise exception 'unknown rule %', p->>'code'; end if;
  -- an owner change also goes to the open alerts that had the old default or none
  if p ? 'owner' then update jt.alerts set owner = p->>'owner' where rule = p->>'code' and status in ('open', 'acked', 'snoozed') and owner = ''; end if;
  return r;
end $$;

-- web app wrappers (signed-in app users only)
create or replace function public.jt_alert_act(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.alert_act(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', 'dashboard')));
end $$;
create or replace function public.jt_alert_rule_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.alert_rule_set(p);
end $$;
create or replace function public.jt_alerts_refresh() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.refresh_alerts();
end $$;

revoke all on function jt.alert_candidates(), jt.refresh_alerts(), jt.alert_act(jsonb), jt.alert_rule_set(jsonb) from public;
revoke all on function public.jt_alert_act(jsonb), public.jt_alert_rule_set(jsonb), public.jt_alerts_refresh() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_alert_act(jsonb), public.jt_alert_rule_set(jsonb), public.jt_alerts_refresh() from anon;
    grant execute on function public.jt_alert_act(jsonb), public.jt_alert_rule_set(jsonb), public.jt_alerts_refresh() to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.alerts, jt.alert_rules to jt_reader;
  end if;
end $$;
