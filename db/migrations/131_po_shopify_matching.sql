-- Purchase orders made in Seller Sage first (Brian, Oct 12: Claude builds a Shopify-store PO from ordering ideas, then
-- fills in the matching Shopify PO through Chrome; it's received in Shopify). When that Shopify PO syncs in, it's
-- linked to the Seller Sage PO waiting for it instead of making a second one:
--  · waiting = no Shopify link, not "no Shopify PO", not complete, made in the last 180 days, with Shopify-store lines;
--  · exactly one waiting PO with the same products (and nothing else close) → linked automatically;
--  · otherwise any waiting PO sharing at least half the products is suggested (jt.shopify_pos.ss_suggest) and nothing
--    is made until someone links it or says "Not this one" (ss_rejected; when no suggestion is left, it's brought in
--    as a new PO the usual way);
--  · no waiting PO close → brought in as a new PO (migration 130).
-- public.jt_po_shopify_link(p {order_id, shopify_po_id, action: link | reject}) does the page's Link / Not this one,
-- and links one picked by hand.
alter table jt.shopify_pos add column if not exists ss_suggest bigint[] not null default '{}';
alter table jt.shopify_pos add column if not exists ss_rejected bigint[] not null default '{}';

-- the Shopify check the page shows (every Shopify line, matched to the catalog or not)
create or replace function jt.shopify_po_check(spo bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('checked_at', now(), 'source', 'shopify', 'file_name', sp.name, 'name', sp.name, 'supplier', sp.supplier,
    'total', sp.total, 'subtotal', sp.total, 'shipping', null, 'scope', 'all', 'auto', true,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', case when v.variant_id is not null then l.variant_id::text end,
                'sku', l.sku, 'title', l.title, 'qty', l.qty, 'cost', l.cost,
                'how', case when v.variant_id is not null then 'shopify' else '' end, 'alts', '[]'::jsonb) order by l.line_id), '[]'::jsonb)
              from jt.shopify_po_lines l left join jt.variants v on v.variant_id = l.variant_id where l.po_id = spo))
  from jt.shopify_pos sp where sp.id = spo
$$;

-- Seller Sage POs waiting for a Shopify PO, and how close each is to this one
create or replace function jt.po_waiting_for(spo bigint)
returns table (order_id bigint, common int, n_sp int, n_ss int, same_qty boolean)
language sql stable security definer set search_path = '' as $$
  with sp as (select variant_id, sum(qty) as qty from jt.shopify_po_lines where po_id = spo and variant_id is not null group by 1),
  w as (select o.id from jt.prep_orders o
        where coalesce(o.shopify_po_url, '') = '' and not o.no_shopify_po
          and o.status in ('draft', 'ordered', 'invoiced', 'partial') and o.created_at > now() - interval '180 days'
          and not o.id = any(coalesce((select ss_rejected from jt.shopify_pos where id = spo), '{}'))
          and not exists (select 1 from jt.shopify_pos x where x.ss_order_id = o.id)),
  ss as (select l.order_id, l.variant_id, sum(l.qty_ordered) as qty from jt.prep_order_lines l join w on w.id = l.order_id
         where l.dest = 'shopify' group by 1, 2)
  select s.order_id,
         count(*) filter (where p.variant_id is not null)::int,
         (select count(*) from sp)::int,
         count(*)::int,
         bool_and(p.qty is not distinct from s.qty)
  from ss s left join sp p on p.variant_id = s.variant_id
  group by s.order_id
  having count(*) filter (where p.variant_id is not null) > 0
$$;

create or replace function jt.po_link_shopify(ord bigint, spo bigint, who text default 'Shopify (auto)') returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  update jt.prep_orders set
    shopify_po_url = 'https://admin.shopify.com/store/' || coalesce(nullif((select value->>'admin_store' from fin.settings s where s.key = 'shop_post'), ''), 'justtennis-822')
                     || '/purchase_orders/' || spo,
    shopify_check = jt.shopify_po_check(spo), no_shopify_po = false, updated_at = now()
  where id = ord;
  update jt.prep_orders set status = 'ordered', stage_at = coalesce(stage_at, '{}'::jsonb) || jsonb_build_object('ordered', now())
  where id = ord and status = 'draft';
  update jt.shopify_pos set ss_imported_at = now(), ss_order_id = ord, ss_suggest = '{}' where id = spo;
  perform jt.po_follow_shopify(spo::text);
  return ord;
end $$;

-- migration 130's import, now looking for a waiting Seller Sage PO first
create or replace function jt.po_import_shopify(spo bigint, any_age boolean default false) returns bigint
language plpgsql security definer set search_path = '' as $$
declare sp record; ord bigint; pkey text; vend text; lines jsonb; chk jsonb; n_un int; url text; exact bigint[]; close bigint[];
begin
  select * into sp from jt.shopify_pos where id = spo;
  if sp.id is null or sp.ss_imported_at is not null or sp.lines_synced is null
     or upper(coalesce(sp.status, '')) in ('', 'DRAFT', 'CANCELLED', 'CANCELED')
     or (not any_age and coalesce(sp.created_at, '-infinity') < '2026-10-05') then
    return null;
  end if;
  pkey := regexp_replace(regexp_replace(lower(sp.name), '[^a-z0-9]', '', 'g'), '^po', '');
  select o.id into ord from jt.prep_orders o
  where o.shopify_po_url ~ ('/purchase_orders/' || spo || '([/?#]|$)')
     or (pkey <> '' and regexp_replace(regexp_replace(lower(o.po_no), '[^a-z0-9]', '', 'g'), '^po', '') = pkey)
  order by o.id limit 1;
  if ord is not null then   -- already here (made by hand)
    update jt.shopify_pos set ss_imported_at = now(), ss_order_id = ord, ss_suggest = '{}' where id = spo;
    return null;
  end if;
  -- a Seller Sage PO waiting for this one?
  select coalesce(array_agg(order_id order by order_id) filter (where common = n_sp and common = n_ss), '{}'),
         coalesce(array_agg(order_id order by common desc, order_id) filter (where common * 2 >= greatest(n_sp, n_ss)), '{}')
    into exact, close
  from jt.po_waiting_for(spo);
  if cardinality(exact) = 1 and cardinality(close) = 1 then
    return jt.po_link_shopify(exact[1], spo);
  end if;
  if cardinality(close) > 0 then
    update jt.shopify_pos set ss_suggest = close where id = spo and ss_suggest is distinct from close;
    return null;
  end if;
  update jt.shopify_pos set ss_suggest = '{}' where id = spo and cardinality(ss_suggest) > 0;
  select coalesce(jsonb_agg(jsonb_build_object('variant_id', variant_id, 'dest', 'shopify', 'qty', qty, 'unit_cost', cost) order by variant_id), '[]'::jsonb)
    into lines
  from (select variant_id, sum(qty)::int as qty, max(cost) as cost from jt.shopify_po_lines
        where po_id = spo and variant_id is not null and variant_id in (select variant_id from jt.variants) group by variant_id) x;
  if jsonb_array_length(lines) = 0 then return null; end if;
  select v.vendor into vend from jt.shopify_po_lines l join jt.variants v on v.variant_id = l.variant_id
  where l.po_id = spo and coalesce(v.vendor, '') <> '' group by v.vendor order by sum(l.qty) desc, v.vendor limit 1;
  select count(*) into n_un from jt.shopify_po_lines l where l.po_id = spo and (l.variant_id is null or l.variant_id not in (select variant_id from jt.variants));
  url := 'https://admin.shopify.com/store/' || coalesce(nullif((select value->>'admin_store' from fin.settings s where s.key = 'shop_post'), ''), 'justtennis-822')
         || '/purchase_orders/' || spo;
  chk := jt.shopify_po_check(spo) || jsonb_build_object('created_from', true);
  ord := jt.prep_order_save(jsonb_build_object(
    'vendor', coalesce(vend, nullif(sp.supplier, ''), ''), 'po_no', regexp_replace(sp.name, '^#\s*', ''),
    'expected_on', (sp.expected_at at time zone 'America/Los_Angeles')::date,
    'note', case when n_un > 0 then n_un || ' product' || case when n_un = 1 then '' else 's' end || ' on the Shopify PO couldn''t be found in the catalog — pick them in the Shopify PO check.' else '' end,
    'receive_into', 'shopify', 'shopify_po_url', url, 'shopify_check', chk, 'lines', lines, 'by', 'Shopify (auto)'));
  update jt.prep_orders set status = 'ordered', stage_at = coalesce(stage_at, '{}'::jsonb) || jsonb_build_object('ordered', coalesce(sp.created_at, now())), updated_at = now()
  where id = ord and status = 'draft';
  update jt.shopify_pos set ss_imported_at = now(), ss_order_id = ord where id = spo;
  perform jt.po_follow_shopify(spo::text);
  return ord;
end $$;

-- the page: Link (a suggestion, or one picked by hand) / Not this one
create or replace function public.jt_po_shopify_link(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'order_id')::bigint; spo bigint := (p->>'shopify_po_id')::bigint; act text := coalesce(p->>'action', 'link');
        who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', ''); other bigint;
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from jt.shopify_pos where id = spo) then raise exception 'Shopify PO % not found', spo; end if;
  if not exists (select 1 from jt.prep_orders where id = ord) then raise exception 'PO % not found', ord; end if;
  if act = 'link' then
    select ss_order_id into other from jt.shopify_pos where id = spo;
    if other is not null and other <> ord and exists (select 1 from jt.prep_orders where id = other) then
      raise exception 'That Shopify PO is already linked to another Seller Sage PO (#%)', other;
    end if;
    perform jt.po_link_shopify(ord, spo, who);
    return jsonb_build_object('linked', true);
  elsif act = 'reject' then
    update jt.shopify_pos set ss_rejected = array_append(array_remove(ss_rejected, ord), ord), ss_suggest = array_remove(ss_suggest, ord) where id = spo;
    -- nothing else suggested: bring it in the usual way (it may make a new PO)
    if (select cardinality(ss_suggest) from jt.shopify_pos where id = spo) = 0 then perform jt.po_import_shopify(spo, true); end if;
    return jsonb_build_object('linked', false);
  end if;
  raise exception 'unknown action %', act;
end $$;

revoke all on function jt.shopify_po_check(bigint), jt.po_waiting_for(bigint), jt.po_link_shopify(bigint, bigint, text) from public;
revoke all on function public.jt_po_shopify_link(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.jt_po_shopify_link(jsonb) from anon;
    grant execute on function public.jt_po_shopify_link(jsonb) to authenticated;
  end if;
end $$;
