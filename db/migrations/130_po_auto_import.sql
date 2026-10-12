-- Purchase orders: new and changed Shopify POs come into Seller Sage by themselves (Brian, Oct 12). Once the sync has read a
-- Shopify PO's lines, a Seller Sage PO is made from it — the same as "Create Seller Sage PO": vendor (the catalog vendor
-- of its products, else Shopify's supplier), PO number, expected date, a Shopify-store line per product with Shopify's
-- quantity and cost, the Shopify link and the Shopify check (so it matches) — and set to Ordered. Then it follows
-- Shopify's receipts (migration 129). POs created since Oct 5, 2026 come in as soon as they're read; an older open PO
-- (the sync reads those again from now on, e.g. ones partly received) comes in when more is received on it — the
-- first receipt check only sets where it stands (any_age). Never drafts or cancelled ones, and never one already here (by the Shopify link or the same PO number). Each Shopify PO is brought in
-- once (jt.shopify_pos.ss_imported_at): deleting the Seller Sage PO doesn't bring it back. Products Shopify's catalog
-- doesn't know are left off the lines and listed in the Shopify check for picking by hand.
alter table jt.shopify_pos add column if not exists ss_imported_at timestamptz;
alter table jt.shopify_pos add column if not exists ss_order_id bigint;

create or replace function jt.po_import_shopify(spo bigint, any_age boolean default false) returns bigint
language plpgsql security definer set search_path = '' as $$
declare sp record; ord bigint; pkey text; vend text; lines jsonb; chk jsonb; n_un int; url text;
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
    update jt.shopify_pos set ss_imported_at = now(), ss_order_id = ord where id = spo;
    return null;
  end if;
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
  chk := jsonb_build_object('checked_at', now(), 'source', 'shopify', 'file_name', sp.name, 'name', sp.name, 'supplier', sp.supplier,
    'total', sp.total, 'subtotal', sp.total, 'shipping', null, 'scope', 'all', 'created_from', true, 'auto', true,
    'lines', (select coalesce(jsonb_agg(jsonb_build_object('variant_id', case when l.variant_id in (select variant_id from jt.variants) then l.variant_id::text end,
                'sku', l.sku, 'title', l.title, 'qty', l.qty, 'cost', l.cost,
                'how', case when l.variant_id in (select variant_id from jt.variants) then 'shopify' else '' end, 'alts', '[]'::jsonb) order by l.line_id), '[]'::jsonb)
              from jt.shopify_po_lines l where l.po_id = spo));
  ord := jt.prep_order_save(jsonb_build_object(
    'vendor', coalesce(vend, nullif(sp.supplier, ''), ''), 'po_no', regexp_replace(sp.name, '^#\s*', ''),
    'expected_on', (sp.expected_at at time zone 'America/Los_Angeles')::date,
    'note', case when n_un > 0 then n_un || ' product' || case when n_un = 1 then '' else 's' end || ' on the Shopify PO couldn''t be found in the catalog — pick them in the Shopify PO check.' else '' end,
    'receive_into', 'shopify', 'shopify_po_url', url, 'shopify_check', chk, 'lines', lines, 'by', 'Shopify (auto)'));
  update jt.prep_orders set status = 'ordered', stage_at = coalesce(stage_at, '{}'::jsonb) || jsonb_build_object('ordered', coalesce(sp.created_at, now())), updated_at = now()
  where id = ord and status = 'draft';
  update jt.shopify_pos set ss_imported_at = now(), ss_order_id = ord where id = spo;
  perform jt.po_follow_shopify(spo::text);   -- already received in Shopify? (migration 129)
  return ord;
end $$;
revoke all on function jt.po_import_shopify(bigint, boolean) from public;

-- at the end of the sync's transaction for a PO (its lines are written by then)
create or replace function jt.trg_po_import_shopify() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.ss_imported_at is null and new.lines_synced is not null then perform jt.po_import_shopify(new.id); end if;
  return null;
end $$;
-- an older PO: more received on it than at the last receipt check (recv_synced: it's been checked before)
create or replace function jt.trg_po_import_shopify_more() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.ss_imported_at is null and old.recv_synced is not null and coalesce(new.recv_units, 0) > coalesce(old.recv_units, 0) then
    perform jt.po_import_shopify(new.id, true);
  end if;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'po_import_shopify') then
    create constraint trigger po_import_shopify after insert or update on jt.shopify_pos
      deferrable initially deferred for each row execute function jt.trg_po_import_shopify();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'po_import_shopify_more') then
    create trigger po_import_shopify_more after update of recv_units on jt.shopify_pos
      for each row execute function jt.trg_po_import_shopify_more();
  end if;
end $$;

-- the Shopify POs not brought in yet
do $$ declare r record; begin
  for r in select id from jt.shopify_pos where ss_imported_at is null and lines_synced is not null and created_at >= '2026-10-05' order by created_at loop
    perform jt.po_import_shopify(r.id);
  end loop;
end $$;
