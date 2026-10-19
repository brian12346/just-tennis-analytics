-- Price match › MAP files (Brian, Oct 19: "here is the new wilson MAP file for Q4. let's queue this up for adjusting
-- prices on shopify and amazon. it will need to be a scheduled job. and let's add a file upload area to the price match
-- for new MAP files").
--
-- A brand's MAP file (Excel/CSV, read on the page: item SKU, UPC, previous MAP and one column per effective date, "OFF" =
-- MAP removed) is saved here, its prices go into the MAP floors (jt.pm_map_floors, per item SKU and per matched Shopify
-- SKU, so the daily price match never goes under them), and a queue of price changes is built for each effective date:
--   * the MAP changes on that date  -> our price moves to the new MAP (down or up)            map_down / map_up
--   * the MAP stays the same         -> only a price under it is raised to it                   map_below
--   * MAP removed (OFF)              -> nothing
-- (Brian's choice, Oct 19: "Follow MAP changes", auto-apply on the date.) Rows can be skipped on the page until then.
-- pg_cron "jt-map-apply" (shortly after midnight Pacific) runs jt.pm_map_due(): Shopify rows become approved price
-- changes (jt.pm_changes, source "<brand> MAP", map_kind set) and the price-match-apply sync job writes them; Amazon rows
-- go through the pm-amazon edge function (action "map_apply": our price, and the minimum price lowered with it when it
-- would be above the new price).

create table if not exists jt.pm_map_files (
  id           bigserial primary key,
  brand        text not null,
  file_name    text not null default '',
  dates        date[] not null default '{}',
  items        int not null default 0,
  uploaded_by  text not null default '',
  uploaded_at  timestamptz not null default now()
);

create table if not exists jt.pm_map_items (
  id           bigserial primary key,
  file_id      bigint not null references jt.pm_map_files(id),
  sku          text not null,                      -- the brand's item / material number
  base         text not null default '',
  upc          text not null default '',           -- digits, leading zeros removed
  description  text not null default '',
  prev_map     numeric(12,2),                      -- MAP before the first date in the file (null = none or OFF)
  maps         jsonb not null default '[]'::jsonb, -- [{d: "2026-11-01", p: 199 | null (OFF)}] by date
  note         text not null default ''
);
create index if not exists pm_map_items_file on jt.pm_map_items (file_id);

create table if not exists jt.pm_map_queue (
  id              bigserial primary key,
  file_id         bigint not null references jt.pm_map_files(id),
  brand           text not null,
  effective_from  date not null,
  channel         text not null check (channel in ('shopify', 'amazon')),
  key             text not null,                  -- Shopify variant id, or the Amazon seller SKU
  variant_id      bigint,
  product_id      bigint,
  sku             text not null default '',       -- our SKU (Shopify or Amazon)
  asin            text not null default '',
  title           text not null default '',
  item_sku        text not null default '',       -- the brand's item number from the file
  upc             text not null default '',
  old_map         numeric(12,2),
  new_map         numeric(12,2) not null,
  price_now       numeric(12,2),                  -- our price when the queue was built (re-checked on the date)
  reason          text not null check (reason in ('map_down', 'map_up', 'map_below')),
  status          text not null default 'queued'
                  check (status in ('queued', 'skipped', 'replaced', 'sending', 'sent', 'applied', 'unchanged', 'failed')),
  change_id       bigint,                         -- the jt.pm_changes row (Shopify)
  new_price       numeric(12,2),                  -- the price set (Amazon; Shopify: see the change)
  error           text not null default '',
  decided_by      text not null default '',
  done_at         timestamptz,
  created_at      timestamptz not null default now(),
  unique (file_id, effective_from, channel, key)
);
create index if not exists pm_map_queue_due on jt.pm_map_queue (status, effective_from);

-- Shopify changes made because of a MAP file: written whatever the price is by then, compare-at kept only when above
alter table jt.pm_changes add column if not exists map_kind text not null default '';

-- ---------------------------------------------------------------------------------------------- queue
-- (re)build the queue for a file: new rows only (existing rows, skipped ones included, stay as they are)
create or replace function jt.pm_map_queue_build(fid bigint) returns int
language plpgsql security definer set search_path = '' as $$
declare f jt.pm_map_files; n int;
begin
  select * into f from jt.pm_map_files where id = fid;
  if f.id is null then return 0; end if;
  with steps as (   -- each item's MAP on each date, with the MAP in force before it
    select i.sku as item_sku, i.upc, (e->>'d')::date as d, nullif(e->>'p', '')::numeric as new_map,
           lag(nullif(e->>'p', '')::numeric, 1, i.prev_map) over (partition by i.id order by (e->>'d')::date) as old_map
    from jt.pm_map_items i cross join jsonb_array_elements(i.maps) e
    where i.file_id = fid
  ), due as (
    select * from steps where new_map is not null and d >= (now() at time zone 'America/Los_Angeles')::date
  ), shop as (
    select distinct on (s.d, v.variant_id) s.*, v.variant_id, v.product_id, v.sku as vsku, v.price,
           trim(v.product_title || case when coalesce(v.variant_title, '') not in ('', 'Default Title') then ' · ' || v.variant_title else '' end) as title
    from due s join jt.variants v on v.removed_at is null and upper(coalesce(v.status, '')) = 'ACTIVE'
      and ((s.upc <> '' and ltrim(coalesce(v.barcode, ''), '0') = s.upc) or upper(coalesce(v.sku, '')) = upper(s.item_sku))
    order by s.d, v.variant_id, (upper(coalesce(v.sku, '')) = upper(s.item_sku)) desc
  ), amz_skus as (
    select sku, asin from jt.fba_inventory where active and asin <> ''
    union select sku, asin from jt.v_fbm_listings where asin <> ''
  ), amz as (
    select distinct on (s.d, a.sku) s.*, a.sku as asku, a.asin,
           coalesce(o.our_price, p.own_price, l.price) as price, coalesce(nullif(l.title, ''), u.title, '') as title
    from due s join jt.pm_upc_asin u on s.upc <> '' and u.asin <> '' and ltrim(u.upc, '0') = s.upc
      join amz_skus a on a.asin = u.asin
      left join jt.pm_amazon_offers o on o.sku = a.sku left join jt.pm_amazon_prices p on p.asin = a.asin
      left join jt.amazon_listings l on l.sku = a.sku
    order by s.d, a.sku
  ), rows as (
    select 'shopify' as channel, variant_id::text as key, variant_id, product_id, vsku as sku, '' as asin, title, item_sku, upc, d, old_map, new_map, price from shop
    union all
    select 'amazon', asku, null, null, asku, asin, title, item_sku, upc, d, old_map, new_map, price from amz
  )
  insert into jt.pm_map_queue (file_id, brand, effective_from, channel, key, variant_id, product_id, sku, asin, title, item_sku, upc,
                               old_map, new_map, price_now, reason)
  select fid, f.brand, d, channel, key, variant_id, product_id, sku, asin, title, item_sku, upc, old_map, new_map, price,
         case when old_map is not null and new_map < old_map - 0.005 then 'map_down'
              when old_map is not null and new_map > old_map + 0.005 then 'map_up' else 'map_below' end
  from rows r
  where case when r.old_map is not null and abs(r.new_map - r.old_map) > 0.005 then r.price is null or abs(r.price - r.new_map) > 0.005
             else r.price is null or r.price < r.new_map - 0.005 end
    -- a MAP over 3x our price is a different pack (a case vs a can on the same UPC), not a price to raise to
    and (r.price is null or r.new_map <= r.price * 3)
  on conflict (file_id, effective_from, channel, key) do nothing;
  get diagnostics n = row_count;
  return n;
end $$;

-- save a MAP file read on the page. p = {brand, file_name, rows: [{sku, base, upc, description, prev, maps: [{d, p}], note}]}
-- or {file_id, rebuild: true} to add queue rows for products / listings matched since (e.g. after the Amazon UPC lookup)
create or replace function jt.pm_map_upload(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare fid bigint; b text := btrim(coalesce(p->>'brand', '')); x jsonb; e jsonb; n int := 0; ds date[]; q int; fl int := 0;
  today date := (now() at time zone 'America/Los_Angeles')::date;
begin
  if p ? 'file_id' then
    fid := (p->>'file_id')::bigint;
    q := jt.pm_map_queue_build(fid);
    return jsonb_build_object('file_id', fid, 'queued', q);
  end if;
  if b = '' then raise exception 'pick the brand for this MAP file'; end if;
  if jsonb_typeof(p->'rows') <> 'array' or jsonb_array_length(p->'rows') = 0 then raise exception 'no rows in the file'; end if;
  insert into jt.pm_map_files (brand, file_name, uploaded_by) values (b, left(coalesce(p->>'file_name', ''), 200), coalesce(p->>'by', ''))
  returning id into fid;
  for x in select * from jsonb_array_elements(p->'rows') loop
    if btrim(coalesce(x->>'sku', '')) = '' then continue; end if;
    -- the same item twice (Wilson lists ball cans and cases under one SKU / UPC): the first row counts
    if exists (select 1 from jt.pm_map_items where file_id = fid and sku = upper(btrim(x->>'sku'))) then continue; end if;
    insert into jt.pm_map_items (file_id, sku, base, upc, description, prev_map, maps, note)
    values (fid, upper(btrim(x->>'sku')), upper(btrim(coalesce(x->>'base', ''))), ltrim(regexp_replace(coalesce(x->>'upc', ''), '\D', '', 'g'), '0'),
            left(btrim(coalesce(x->>'description', '')), 200), nullif(x->>'prev', '')::numeric,
            coalesce((select jsonb_agg(jsonb_build_object('d', (m->>'d')::date, 'p', nullif(m->>'p', '')::numeric) order by (m->>'d')::date)
                      from jsonb_array_elements(coalesce(x->'maps', '[]'::jsonb)) m where nullif(m->>'d', '') is not null), '[]'::jsonb),
            left(coalesce(x->>'note', ''), 200));
    n := n + 1;
  end loop;
  select coalesce(array_agg(distinct (e2->>'d')::date order by (e2->>'d')::date), '{}') into ds
  from jt.pm_map_items i cross join jsonb_array_elements(i.maps) e2 where i.file_id = fid;
  update jt.pm_map_files set items = n, dates = ds where id = fid;

  -- MAP floors for the daily price match: per item SKU and per matched Shopify SKU (under its own vendor too);
  -- the previous MAP from today, then each date's (OFF = 0: no floor)
  with it as (select * from jt.pm_map_items where file_id = fid),
  pts as (
    select i.id, i.sku, i.upc, today as d, coalesce(i.prev_map, 0) as price from it i where i.prev_map is not null or jsonb_array_length(i.maps) = 0
    union all
    select i.id, i.sku, i.upc, (m->>'d')::date, coalesce(nullif(m->>'p', '')::numeric, 0) from it i cross join jsonb_array_elements(i.maps) m
  ), keys as (
    select distinct b as brand, upper(i.sku) as prefix, i.id from it i
    union
    select distinct coalesce(nullif(v.vendor, ''), b), upper(v.sku), i.id from it i join jt.variants v on v.removed_at is null and coalesce(v.sku, '') <> ''
      and ((i.upc <> '' and ltrim(coalesce(v.barcode, ''), '0') = i.upc) or upper(v.sku) = upper(i.sku))
    union
    select distinct b, upper(v.sku), i.id from it i join jt.variants v on v.removed_at is null and coalesce(v.sku, '') <> ''
      and ((i.upc <> '' and ltrim(coalesce(v.barcode, ''), '0') = i.upc) or upper(v.sku) = upper(i.sku))
  )
  insert into jt.pm_map_floors (brand, sku_prefix, map_price, effective_from, source, added_by, active)
  select distinct on (k.brand, k.prefix, t.d) k.brand, k.prefix, t.price, t.d, coalesce(p->>'file_name', 'MAP file'), coalesce(p->>'by', ''), true
  from keys k join pts t on t.id = k.id
  order by k.brand, k.prefix, t.d, t.price desc
  on conflict (brand, sku_prefix, effective_from) do update set map_price = excluded.map_price, source = excluded.source,
    added_by = excluded.added_by, active = true;
  get diagnostics fl = row_count;

  -- a newer file for the brand replaces what an older one still had queued
  update jt.pm_map_queue set status = 'replaced', error = 'replaced by ' || coalesce(nullif(p->>'file_name', ''), 'a newer file')
  where brand = b and file_id <> fid and status in ('queued', 'skipped');
  q := jt.pm_map_queue_build(fid);
  return jsonb_build_object('file_id', fid, 'items', n, 'dates', to_jsonb(ds), 'floors', fl, 'queued', q);
end $$;

-- skip / un-skip queued rows: p = {ids: [...], skip: true|false}
create or replace function jt.pm_map_skip(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update jt.pm_map_queue set status = case when coalesce((p->>'skip')::boolean, true) then 'skipped' else 'queued' end,
    decided_by = coalesce(p->>'by', '')
  where id in (select v::bigint from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) v)
    and status = case when coalesce((p->>'skip')::boolean, true) then 'queued' else 'skipped' end;
  get diagnostics n = row_count;
  return jsonb_build_object('changed', n);
end $$;

-- the scheduled step (pg_cron "jt-map-apply"): rows due today (Pacific) -> Shopify approved changes + the Amazon call
create or replace function jt.pm_map_due() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'America/Los_Angeles')::date; r record; rid bigint; cid bigint; n_sent int := 0; n_same int := 0; n_amz int;
  fid bigint;
begin
  -- products and listings added since the upload
  for fid in select distinct file_id from jt.pm_map_queue where status = 'queued' and effective_from <= today loop
    perform jt.pm_map_queue_build(fid);
  end loop;
  for r in select q.*, v.price as cur, v.product_title, v.variant_title, v.vendor, v.unit_cost, v.removed_at, v.sku as vsku
           from jt.pm_map_queue q left join jt.variants v on v.variant_id = q.variant_id
           where q.channel = 'shopify' and q.status = 'queued' and q.effective_from <= today order by q.id loop
    if r.cur is null or r.removed_at is not null then
      update jt.pm_map_queue set status = 'failed', error = 'the variant is no longer in Shopify', done_at = now() where id = r.id; continue;
    end if;
    if (r.reason = 'map_below' and r.cur >= r.new_map - 0.005) or abs(r.cur - r.new_map) <= 0.005 then
      update jt.pm_map_queue set status = 'unchanged', new_price = r.cur, done_at = now() where id = r.id; n_same := n_same + 1; continue;
    end if;
    if rid is null then
      insert into jt.pm_runs (mode, status, finished_at, started_by, summary)
      values ('map', 'done', now(), r.brand || ' MAP', jsonb_build_object('map', jsonb_build_object('brand', r.brand, 'date', today)))
      returning id into rid;
    end if;
    -- proposals still waiting for this variant are out of date now
    update jt.pm_changes set status = 'superseded', error = 'replaced by the ' || r.brand || ' MAP change'
    where variant_id = r.variant_id and status = 'proposed';
    insert into jt.pm_changes (run_id, product_id, variant_id, product_title, variant_title, sku, vendor, source, competitor_ref,
                               old_price, new_price, cost, map_price, reason, map_kind, status, decided_by, decided_at)
    values (rid, r.product_id, r.variant_id, coalesce(r.product_title, ''), coalesce(r.variant_title, ''), coalesce(r.vsku, ''), coalesce(r.vendor, ''),
            r.brand || ' MAP', case when r.reason = 'map_below' then 'MAP ' || r.new_map::text || ' (our price was under it)'
              else 'MAP ' || coalesce(r.old_map::text, '—') || ' → ' || r.new_map::text || ' from ' || to_char(r.effective_from, 'Mon FMDD') end,
            r.cur, r.new_map, r.unit_cost, r.new_map, 'restore', r.reason, 'approved', 'MAP schedule', now())
    returning id into cid;
    update jt.pm_map_queue set status = 'sent', change_id = cid, new_price = r.new_map, done_at = now() where id = r.id;
    n_sent := n_sent + 1;
  end loop;
  if rid is not null then
    update jt.pm_runs set summary = summary || jsonb_build_object('totals', jsonb_build_object('map_changes', n_sent, 'unchanged', n_same)) where id = rid;
  end if;
  if n_sent > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then perform jt.dispatch_sync('price-match-apply'); end if;
  select count(*) into n_amz from jt.pm_map_queue where channel = 'amazon' and effective_from <= today
    and (status = 'queued' or (status = 'sending' and done_at < now() - interval '15 minutes'));
  if n_amz > 0 then perform jt.pm_amazon_call('{"action":"map_apply"}'::jsonb); end if;
  return jsonb_build_object('shopify', n_sent, 'unchanged', n_same, 'amazon', n_amz);
end $$;

-- ---------------------------------------------------------------------------------------------- pm-amazon (service role)
-- Amazon rows due now (marked "sending" so a second call doesn't take them too)
create or replace function public.jt_pm_map_amazon_due(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare today date := (now() at time zone 'America/Los_Angeles')::date; r jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with picked as (
    select id from jt.pm_map_queue
    where channel = 'amazon' and effective_from <= today
      and (status = 'queued' or (status = 'sending' and done_at < now() - interval '15 minutes'))
    order by id limit coalesce((p->>'limit')::int, 120) for update skip locked
  ), upd as (
    update jt.pm_map_queue q set status = 'sending', done_at = now() from picked where q.id = picked.id
    returning q.id, q.sku, q.asin, q.new_map, q.reason, q.brand, q.effective_from
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'sku', sku, 'asin', asin, 'price', new_map, 'reason', reason,
           'by', brand || ' MAP (' || to_char(effective_from, 'Mon FMDD') || ')')), '[]'::jsonb) into r from upd;
  return r;
end $$;

-- results: p = {rows: [{id, status: applied|unchanged|failed, price, error}]}
create or replace function public.jt_pm_map_amazon_done(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update jt.pm_map_queue q set status = x.status, new_price = coalesce(x.price, q.new_price), error = left(coalesce(x.error, ''), 500), done_at = now()
  from jsonb_to_recordset(coalesce(p->'rows', '[]'::jsonb)) as x(id bigint, status text, price numeric, error text)
  where q.id = x.id and x.status in ('applied', 'unchanged', 'failed');
  get diagnostics n = row_count;
  return n;
end $$;

-- UPCs of a file without an Amazon ASIN lookup in the last 30 days (for pm-amazon "map_lookup")
create or replace function public.jt_pm_map_lookup_todo(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(u) from (
    select distinct lpad(i.upc, case when length(i.upc) <= 12 then 12 else length(i.upc) end, '0') as u
    from jt.pm_map_items i
    where i.file_id = (p->>'file_id')::bigint and i.upc <> '' and length(i.upc) between 8 and 14
      and not exists (select 1 from jt.pm_upc_asin x where ltrim(x.upc, '0') = i.upc and x.checked_at > now() - interval '30 days')
    limit 1000) t), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------------------------------------- page
create or replace view jt.v_pm_map_queue as
select q.id, q.file_id, q.brand, q.effective_from, q.channel, q.variant_id, q.product_id, q.sku, q.asin, q.title, q.item_sku, q.upc,
       q.old_map, q.new_map, q.price_now, q.reason, q.decided_by, q.created_at, f.file_name,
       case when q.status = 'sent' then case c.status when 'applied' then 'applied' when 'failed' then 'failed' when 'rolled_back' then 'rolled back'
                                                       when 'approved' then 'sending' else coalesce(c.status, 'sent') end
            else q.status end as status,
       case when q.status = 'sent' then coalesce(nullif(c.error, ''), q.error) else q.error end as error,
       coalesce(q.new_price, c.new_price) as new_price, coalesce(c.applied_at, q.done_at) as done_at, q.change_id,
       v.price as price_shopify, coalesce(o.our_price, pp.own_price) as price_amazon
from jt.pm_map_queue q join jt.pm_map_files f on f.id = q.file_id
left join jt.pm_changes c on c.id = q.change_id
left join jt.variants v on v.variant_id = q.variant_id
left join jt.pm_amazon_offers o on q.channel = 'amazon' and o.sku = q.sku
left join jt.pm_amazon_prices pp on q.channel = 'amazon' and pp.asin = q.asin;

create or replace function public.jt_pm_map_upload(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.pm_map_upload(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_pm_map_skip(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.pm_map_skip(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
grant execute on function public.jt_pm_map_upload(jsonb), public.jt_pm_map_skip(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.pm_map_files, jt.pm_map_items, jt.pm_map_queue, jt.v_pm_map_queue to jt_reader;
  end if;
end $$;
