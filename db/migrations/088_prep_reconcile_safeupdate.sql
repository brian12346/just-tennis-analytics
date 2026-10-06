-- 087's reconcile cleared its scratch table with a bare DELETE, which the web's database role refuses (Supabase's
-- pg-safeupdate: "DELETE requires a WHERE clause"), so linking with a quantity difference failed on the web page.
-- Same function, with the scratch table dropped and created fresh instead.
create or replace function jt.prep_ship_reconcile(sid bigint, p jsonb, who text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare s record; v bigint; o int; n int; sur int; dsp jsonb; tsku text; x record; need int; got int; avail int;
  sname text; to_prep int := 0; to_shop int := 0; taken int := 0; short int := 0; shipped boolean;
begin
  select * into s from jt.prep_shipments where id = sid for update;
  if s.id is null then raise exception 'shipment % not found', sid; end if;
  shipped := s.status = 'shipped';
  sname := coalesce(nullif(s.name, ''), 'Shipment ' || sid);
  -- a fresh table each call (no bare DELETE: the web's database role runs with pg-safeupdate, which refuses it)
  drop table if exists pg_temp._rec_new;
  create temp table _rec_new (variant_id bigint, amazon_sku text, qty int) on commit drop;
  insert into pg_temp._rec_new select (l->>'variant_id')::bigint, coalesce(l->>'amazon_sku', ''), sum((l->>'qty')::int)
    from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) l where coalesce((l->>'qty')::int, 0) > 0 group by 1, 2;
  if not exists (select 1 from pg_temp._rec_new) then raise exception 'Seller Central has no products for this shipment'; end if;

  for v in select variant_id from jt.prep_shipment_lines where shipment_id = sid union select variant_id from pg_temp._rec_new loop
    select coalesce(sum(qty), 0) into o from jt.prep_shipment_lines where shipment_id = sid and variant_id = v;
    select coalesce(sum(qty), 0) into n from pg_temp._rec_new where variant_id = v;
    sur := o - n;
    select d into dsp from jsonb_array_elements(coalesce(p->'dispose', '[]'::jsonb)) d where (d->>'variant_id')::bigint = v limit 1;
    tsku := case when dsp ? 'amazon_sku' then coalesce(dsp->>'amazon_sku', '') else coalesce((select amazon_sku from pg_temp._rec_new where variant_id = v order by qty desc limit 1),
                     (select amazon_sku from jt.prep_shipment_lines where shipment_id = sid and variant_id = v order by qty desc limit 1), '') end;
    if not shipped then
      -- earmark what Seller Central expects per listing, from the product's not-earmarked stock
      for x in select * from pg_temp._rec_new where variant_id = v and amazon_sku <> '' loop
        select coalesce((select qty from jt.prep_items where variant_id = v and amazon_sku = x.amazon_sku), 0) into avail;
        if avail < x.qty then
          got := -jt.prep_stock_add(v, '', -(x.qty - avail), 'assign', 'to ' || x.amazon_sku || ' · Seller Central ' || sname, who, sid, sname);
          perform jt.prep_stock_add(v, x.amazon_sku, got, 'assign', 'from any listing · Seller Central ' || sname, who, sid, sname);
        end if;
      end loop;
    end if;
    if sur > 0 then
      if coalesce(dsp->>'to', 'prep') = 'shopify' then
        if not shipped then
          -- not shipped yet: the units are still on the prep center's count; take them out (not-earmarked stock first)
          need := sur;
          for x in select amazon_sku from jt.prep_items where variant_id = v order by (amazon_sku = '') desc,
                     (amazon_sku in (select amazon_sku from jt.prep_shipment_lines where shipment_id = sid and variant_id = v)) desc, qty desc loop
            exit when need <= 0;
            need := need + jt.prep_stock_add(v, x.amazon_sku, -need, 'to_shopify', 'not in Seller Central ' || sname || ' · back to Shopify', who, sid, sname);
          end loop;
          sur := sur - need;
        end if;
        if sur > 0 then
          insert into jt.shopify_stock_moves (variant_id, delta, reason, prep_shipment_id, created_by)
          values (v, sur, 'Not in Seller Central shipment ' || sname, sid, who);
          to_shop := to_shop + sur;
        end if;
      elsif shipped then
        -- shipped: the units were taken out of the prep center; they come back, earmarked for the listing
        to_prep := to_prep + jt.prep_stock_add(v, tsku, sur, 'reconcile', 'not in Seller Central ' || sname, who, sid, sname);
      else
        -- not shipped: they're still counted; earmark them for the listing (from not-earmarked stock)
        if tsku <> '' then
          got := -jt.prep_stock_add(v, '', -sur, 'assign', 'to ' || tsku || ' · not in Seller Central ' || sname, who, sid, sname);
          perform jt.prep_stock_add(v, tsku, got, 'assign', 'from any listing · not in Seller Central ' || sname, who, sid, sname);
        end if;
        to_prep := to_prep + sur;
      end if;
    elsif sur < 0 and shipped then
      -- Seller Central has more than went out: take the rest out of the prep center (its listings, then not earmarked)
      need := -sur;
      for x in select amazon_sku from jt.prep_items where variant_id = v
                 order by (amazon_sku in (select amazon_sku from pg_temp._rec_new where variant_id = v)) desc, (amazon_sku = '') desc, qty desc loop
        exit when need <= 0;
        need := need + jt.prep_stock_add(v, x.amazon_sku, -need, 'reconcile', 'more in Seller Central ' || sname, who, sid, sname);
      end loop;
      taken := taken + (-sur - need); short := short + need;
    end if;
  end loop;

  delete from jt.prep_shipment_lines where shipment_id = sid;
  insert into jt.prep_shipment_lines (shipment_id, variant_id, amazon_sku, qty) select sid, variant_id, amazon_sku, qty from pg_temp._rec_new;
  delete from jt.prep_items where qty = 0;
  update jt.prep_shipments set updated_at = now() where id = sid;
  if to_shop > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;   -- hourly sync catches it otherwise
  end if;
  return jsonb_build_object('lines', (select count(*) from pg_temp._rec_new), 'to_prep', to_prep, 'to_shopify', to_shop, 'taken', taken, 'short', short);
end $$;
revoke all on function jt.prep_ship_reconcile(bigint, jsonb, text) from public;
