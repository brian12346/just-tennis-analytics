-- Receive against the invoice, store stock too (Brian, Oct 20: "We really should be receiving against an invoice and
-- then tying that to a po. And if we receive against an invoice we should be able to change the po associated with the
-- invoice to another po" — the case: not seeing the open order and starting another PO when the invoice came in).
-- Decided Oct 20: Seller Sage receives everything (Shopify store and prep center); the Shopify PO is only a record.
--   * Receiving a Shopify-store line here puts the units into Shopify (jt.shopify_stock_moves kind 'receive', applied
--     by the fbm-inventory sync at the store location); prep_order_lines.qty_pushed counts them. Un-receiving takes them
--     back out. Receipts copied from a Shopify PO (jt.po_follow_shopify) don't move stock — Shopify already has them.
--   * Units received here and then received on the Shopify PO as well are counted twice in Shopify: the PO shows it
--     (prep_orders.recv_double {variant: units}) and jt.po_fix_double takes the extra back out.
--   * jt.invoice_move now works after receiving: what was received against the invoice moves with it to the other PO
--     (store units stay in Shopify, prep units in the prep center — only the PO bookkeeping moves). Both POs' stages
--     are worked out again; the PO it came off stays as it is otherwise (Brian: "Move the invoice only").

alter table jt.prep_order_lines add column if not exists qty_pushed integer not null default 0;
alter table jt.prep_orders add column if not exists recv_double jsonb not null default '{}'::jsonb;
alter table jt.shopify_stock_moves add column if not exists order_id bigint;

create or replace function jt.prep_order_receive(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; st text; x jsonb; q integer; vid bigint; sku text; d text; n integer := 0; after integer; ref text; done boolean;
  from_shopify boolean := coalesce(p->>'source', '') = 'shopify'; pushed integer := 0;
begin
  select status, coalesce(nullif(po_no, ''), vendor || ' order ' || id) into st, ref from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
  for x in select * from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) loop
    q := coalesce((x->>'qty')::integer, 0); vid := (x->>'variant_id')::bigint; sku := coalesce(x->>'amazon_sku', ''); d := coalesce(nullif(x->>'dest', ''), 'prep');
    if q < 0 then raise exception 'received quantities must be 0 or more'; end if;
    if q = 0 then continue; end if;
    if not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', vid; end if;
    insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, qty_received) values (ord, vid, sku, d, 0, q)
      on conflict (order_id, variant_id, amazon_sku, dest) do update set qty_received = jt.prep_order_lines.qty_received + excluded.qty_received;
    if d = 'shopify' and not from_shopify then
      -- received here: Seller Sage puts the units into Shopify's stock (fbm-inventory sync, store location)
      update jt.prep_order_lines set qty_pushed = qty_pushed + q where order_id = ord and variant_id = vid and amazon_sku = sku and dest = d;
      insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, amazon_sku, order_id, created_by)
      values (vid, q, 'received on ' || ref, 'receive', sku, ord, coalesce(p->>'by', ''));
      pushed := pushed + q;
    end if;
    if d = 'prep' then
      insert into jt.prep_items (variant_id, amazon_sku, qty) values (vid, sku, q)
        on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now()
        returning qty into after;
      insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
      values ('receive', vid, sku, q, after, ref, coalesce(p->>'note', ''), coalesce(p->>'by', ''), ord);
    end if;
    n := n + q;
  end loop;
  if n = 0 then raise exception 'nothing to receive'; end if;
  select not exists (select 1 from jt.prep_order_lines l where l.order_id = ord and l.qty_received < l.qty_ordered) or o.short_ok into done
  from jt.prep_orders o where o.id = ord;
  update jt.prep_orders set status = case when done then 'received' else 'partial' end,
    stage_at = stage_at || case when done then jsonb_build_object('received', now()) else '{}'::jsonb end
      || case when stage_at ? 'partial' then '{}'::jsonb else jsonb_build_object('partial', now()) end,
    updated_at = now() where id = ord;
  update jt.prep_list set closed_at = now() where order_id = ord and closed_at is null;
  if pushed > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;   -- hourly sync catches it otherwise
  end if;
  return n;
end $$;

create or replace function jt.prep_order_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; want text := p->>'status'; o record; l record; have integer; after integer;
begin
  if want not in ('draft', 'ordered', 'invoiced', 'partial', 'received', 'qb_ready', 'complete') then raise exception 'unknown status %', want; end if;
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  if want in ('qb_ready', 'complete') then want := 'received'; end if;          -- QuickBooks is done on the invoice; fully received = complete
  if o.status = want or (want = 'received' and o.status in ('qb_ready', 'complete')) then return o.status; end if;
  if want in ('draft', 'ordered', 'invoiced') then
    if o.status in ('partial', 'received', 'qb_ready', 'complete') then
      -- un-receive: the prep-center units come back out; list items reopen
      for l in select * from jt.prep_order_lines where order_id = ord and qty_received > 0 and dest = 'prep' loop
        select qty into have from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku for update;
        if coalesce(have, 0) < l.qty_received then
          raise exception 'only % of variant % % left in the prep center, % were received on this order — some already went out',
            coalesce(have, 0), l.variant_id, l.amazon_sku, l.qty_received;
        end if;
        update jt.prep_items set qty = qty - l.qty_received, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku
          returning qty into after;
        insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
        values ('unreceive', l.variant_id, l.amazon_sku, -l.qty_received, after, coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
          'moved back to ' || want, coalesce(p->>'by', ''), ord);
      end loop;
      delete from jt.prep_items where qty = 0;
      for l in select * from jt.prep_order_lines where order_id = ord and dest = 'shopify' and qty_pushed > 0 loop
        insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, amazon_sku, order_id, created_by)
        values (l.variant_id, -l.qty_pushed, 'un-received on ' || coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord), 'unreceive', l.amazon_sku, ord, coalesce(p->>'by', ''));
      end loop;
      if found and to_regprocedure('jt.dispatch_sync(text)') is not null then
        begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;
      end if;
      update jt.prep_order_lines set qty_pushed = 0 where order_id = ord;
      delete from jt.prep_order_lines where order_id = ord and qty_ordered = 0 and not exists (
        select 1 from jt.prep_list i where i.order_id = ord and i.variant_id = jt.prep_order_lines.variant_id and i.amazon_sku = jt.prep_order_lines.amazon_sku and i.dest = jt.prep_order_lines.dest);
      update jt.prep_order_lines set qty_received = 0 where order_id = ord;
      update jt.prep_orders set short_ok = false, stage_at = stage_at - 'partial' - 'received' - 'qb_ready' - 'complete' where id = ord;
      update jt.prep_list i set closed_at = null where i.order_id = ord and i.closed_at is not null
        and not exists (select 1 from jt.prep_list j where j.variant_id = i.variant_id and j.amazon_sku = i.amazon_sku and j.dest = i.dest and j.closed_at is null);
    end if;
  elsif want = 'partial' then
    raise exception 'receive the products to make it partly received';
  elsif want = 'received' then
    if o.status = 'partial' then update jt.prep_orders set short_ok = true where id = ord;          -- closed short: the rest isn't coming
    elsif o.status not in ('qb_ready', 'complete') then raise exception 'receive the products first';
    end if;
    update jt.prep_orders set status = 'received', stage_at = stage_at || case when o.status = 'partial' then jsonb_build_object('received', now()) else '{}'::jsonb end,
      updated_at = now() where id = ord;
    return (select status from jt.prep_orders where id = ord);
  elsif want = 'qb_ready' then
    if o.status not in ('received', 'complete') then raise exception 'a PO is QB ready once it''s received'; end if;
    if o.status = 'complete' then update jt.prep_orders set status = want, stage_at = stage_at - 'complete', updated_at = now() where id = ord; return want; end if;
  elsif want = 'complete' then
    if o.status <> 'qb_ready' then raise exception 'mark it QB ready first'; end if;
  end if;
  update jt.prep_orders set status = want, stage_at = stage_at || jsonb_build_object(want, now()), updated_at = now() where id = ord;
  return (select status from jt.prep_orders where id = ord);
end $$;

create or replace function jt.prep_order_unreceive_line(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; o record; l record; q integer := coalesce((p->>'qty')::integer, 0); have integer; after integer; tot integer; full_ boolean;
begin
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  select * into l from jt.prep_order_lines where order_id = ord and variant_id = (p->>'variant_id')::bigint
    and amazon_sku = coalesce(p->>'amazon_sku', '') and dest = coalesce(nullif(p->>'dest', ''), 'prep') for update;
  if l.order_id is null then raise exception 'that product isn''t on this order'; end if;
  if q <= 0 then raise exception 'enter how many to un-receive'; end if;
  if q > l.qty_received then raise exception 'only % of this product were received on this order', l.qty_received; end if;
  if l.dest = 'prep' then
    select qty into have from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku for update;
    if coalesce(have, 0) < q then
      raise exception 'only % of this product are left in the prep center; the rest already went out', coalesce(have, 0);
    end if;
    update jt.prep_items set qty = qty - q, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku returning qty into after;
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, shipment, note, by_user, order_id)
    values ('unreceive', l.variant_id, l.amazon_sku, -q, after, coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
            coalesce(nullif(p->>'note', ''), 'un-received on the PO'), coalesce(p->>'by', ''), ord);
    delete from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku and qty = 0;
  end if;
  if l.dest = 'shopify' and l.qty_pushed > 0 then
    -- units Seller Sage put into Shopify come back out of it
    insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, amazon_sku, order_id, created_by)
    values (l.variant_id, -least(q, l.qty_pushed), 'un-received on ' || coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord), 'unreceive', l.amazon_sku, ord, coalesce(p->>'by', ''));
    update jt.prep_order_lines set qty_pushed = qty_pushed - least(q, l.qty_pushed)
    where order_id = ord and variant_id = l.variant_id and amazon_sku = l.amazon_sku and dest = l.dest;
    if to_regprocedure('jt.dispatch_sync(text)') is not null then
      begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;
    end if;
  end if;
  update jt.prep_order_lines set qty_received = qty_received - q
  where order_id = ord and variant_id = l.variant_id and amazon_sku = l.amazon_sku and dest = l.dest;
  -- take them off the order's invoices too, newest invoice first
  declare left_ numeric := q; r record; t numeric;
  begin
    for r in select ir.invoice_id, ir.qty from jt.invoice_receipts ir join jt.invoices i on i.id = ir.invoice_id
             where i.order_id = ord and ir.variant_id = l.variant_id and ir.qty > 0 order by ir.invoice_id desc loop
      exit when left_ <= 0;
      t := least(left_, r.qty);
      update jt.invoice_receipts set qty = qty - t where invoice_id = r.invoice_id and variant_id = l.variant_id;
      perform jt.invoice_refresh_received(r.invoice_id);
      left_ := left_ - t;
    end loop;
  end;
  select coalesce(sum(qty_received), 0), not exists (select 1 from jt.prep_order_lines where order_id = ord and qty_received < qty_ordered)
    into tot, full_ from jt.prep_order_lines where order_id = ord;
  if o.status in ('partial', 'received', 'qb_ready', 'complete') then
    if tot = 0 then
      update jt.prep_orders set status = case when exists (select 1 from jt.invoices where order_id = ord) then 'invoiced' else 'ordered' end,
        short_ok = false, stage_at = stage_at - 'partial' - 'received' - 'qb_ready' - 'complete', updated_at = now() where id = ord;
    elsif not full_ and not o.short_ok then
      update jt.prep_orders set status = 'partial', stage_at = stage_at - 'received' - 'qb_ready' - 'complete', updated_at = now() where id = ord;
    else
      update jt.prep_orders set updated_at = now() where id = ord;
    end if;
  end if;
  return q;
end $$;

create or replace function jt.po_follow_shopify(spo text) returns integer
language plpgsql security definer set search_path = '' as $$
declare o record; lines jsonb; n integer := 0; dbl jsonb;
begin
  for o in
    select p.id from jt.prep_orders p
    where p.shopify_po_url ~ ('/purchase_orders/' || spo || '([/?#]|$)') and p.status <> 'draft'
  loop
    select coalesce(jsonb_agg(jsonb_build_object('variant_id', x.variant_id, 'amazon_sku', x.sku, 'dest', 'shopify', 'qty', x.gap)), '[]'::jsonb)
      into lines
    from (
      select l.variant_id, l.sku, least(s.got, l.ordered) - l.rec as gap
      from (select variant_id, max(amazon_sku) as sku, sum(qty_ordered) as ordered, sum(qty_received) as rec
            from jt.prep_order_lines where order_id = o.id and dest = 'shopify' group by variant_id) l
      join (select variant_id, sum(qty_received) as got from jt.shopify_po_lines where po_id::text = spo and variant_id is not null group by variant_id) s
        on s.variant_id = l.variant_id
      where least(s.got, l.ordered) > l.rec) x;
    if jsonb_array_length(lines) > 0 then
      n := n + jt.prep_order_receive(jsonb_build_object('id', o.id, 'lines', lines, 'by', 'Shopify', 'note', 'received in Shopify', 'source', 'shopify'));
    end if;
    -- received in Seller Sage (units put into Shopify) and then received on the Shopify PO too: Shopify counted them twice
    select coalesce(jsonb_object_agg(x.variant_id::text, x.dbl), '{}'::jsonb) into dbl
    from (
      select l.variant_id, least(l.pushed, s.got - (l.rec - l.pushed)) as dbl
      from (select variant_id, sum(qty_received) as rec, sum(qty_pushed) as pushed
            from jt.prep_order_lines where order_id = o.id and dest = 'shopify' group by variant_id) l
      join (select variant_id, sum(qty_received) as got from jt.shopify_po_lines where po_id::text = spo and variant_id is not null group by variant_id) s
        on s.variant_id = l.variant_id
      where l.pushed > 0 and s.got > l.rec - l.pushed) x;
    update jt.prep_orders set recv_double = dbl where id = o.id and recv_double is distinct from dbl;
    update jt.prep_orders set shopify_received_at = now(), shopify_received_by = 'Shopify'
    where id = o.id and shopify_received_at is null
      and exists (select 1 from jt.shopify_pos where id::text = spo and recv_status = 'received');
  end loop;
  return n;
end $$;

-- a PO's stage from what it has received (used after an invoice moves)
create or replace function jt.po_restage(ord bigint) returns text
language plpgsql security definer set search_path = '' as $$
declare o record; tot integer; full_ boolean;
begin
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then return null; end if;
  select coalesce(sum(qty_received), 0), not exists (select 1 from jt.prep_order_lines where order_id = ord and qty_received < qty_ordered)
    into tot, full_ from jt.prep_order_lines where order_id = ord;
  if o.status = 'draft' and tot = 0 then return o.status; end if;
  if tot = 0 then
    if o.status in ('partial', 'received', 'qb_ready', 'complete', 'invoiced', 'ordered') then
      update jt.prep_orders set status = case when exists (select 1 from jt.invoices where order_id = ord) then 'invoiced' else 'ordered' end,
        short_ok = false, stage_at = stage_at - 'partial' - 'received' - 'qb_ready' - 'complete', updated_at = now() where id = ord;
    end if;
  elsif full_ or o.short_ok then
    update jt.prep_orders set status = 'received',
      stage_at = stage_at || case when o.status in ('received', 'qb_ready', 'complete') then '{}'::jsonb else jsonb_build_object('received', now()) end
        || case when stage_at ? 'partial' then '{}'::jsonb else jsonb_build_object('partial', now()) end,
      updated_at = now() where id = ord and status not in ('received', 'qb_ready', 'complete');
  else
    update jt.prep_orders set status = 'partial', stage_at = (stage_at - 'received' - 'qb_ready' - 'complete')
        || case when stage_at ? 'partial' then '{}'::jsonb else jsonb_build_object('partial', now()) end, updated_at = now()
    where id = ord and status <> 'partial';
  end if;
  return (select status from jt.prep_orders where id = ord);
end $$;
revoke all on function jt.po_restage(bigint) from public;

-- put a saved invoice on another PO; what was received against it goes along. p = {invoice_id, order_id}
create or replace function jt.invoice_move(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare inv bigint := (p->>'invoice_id')::bigint; ord bigint := (p->>'order_id')::bigint; old bigint; st text; r record; l record;
  left_ integer; t integer; pt integer;
begin
  select coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1)) into old from jt.invoices i where i.id = inv;
  if not found then raise exception 'invoice % not found', inv; end if;
  select status into st from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'purchase order % not found', ord; end if;
  if old = ord then return true; end if;
  if old is not null then
    perform 1 from jt.prep_orders where id = old for update;
    for r in select variant_id, qty::integer as qty from jt.invoice_receipts where invoice_id = inv and qty > 0 loop
      left_ := r.qty;
      for l in select * from jt.prep_order_lines where order_id = old and variant_id = r.variant_id and qty_received > 0
               order by (dest = 'shopify') desc, qty_received desc loop
        exit when left_ <= 0;
        t := least(left_, l.qty_received); pt := least(t, l.qty_pushed);
        update jt.prep_order_lines set qty_received = qty_received - t, qty_pushed = qty_pushed - pt
        where order_id = old and variant_id = l.variant_id and amazon_sku = l.amazon_sku and dest = l.dest;
        insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, qty_received, qty_pushed)
        values (ord, l.variant_id, l.amazon_sku, l.dest, 0, t, pt)
        on conflict (order_id, variant_id, amazon_sku, dest) do update
          set qty_received = jt.prep_order_lines.qty_received + excluded.qty_received, qty_pushed = jt.prep_order_lines.qty_pushed + excluded.qty_pushed;
        left_ := left_ - t;
      end loop;
    end loop;
  end if;
  update jt.invoices set order_id = ord, updated_at = now() where id = inv;
  update jt.prep_orders o set invoice_id = (select max(id) from jt.invoices where order_id = o.id), updated_at = now() where o.id in (ord, old);
  if exists (select 1 from jt.invoice_receipts where invoice_id = inv and qty > 0) then
    perform jt.po_restage(ord);
    if old is not null then perform jt.po_restage(old); end if;
  end if;
  return true;
end $$;
revoke all on function jt.invoice_move(jsonb) from public;

-- take the units Shopify counted twice (received here and on the Shopify PO) back out of Shopify. p = {id}
create or replace function jt.po_fix_double(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; o record; k text; v integer; l record; left_ integer; t integer; n integer := 0;
begin
  select * into o from jt.prep_orders where id = ord for update;
  if o.id is null then raise exception 'order % not found', ord; end if;
  for k, v in select key, value::integer from jsonb_each_text(o.recv_double) loop
    left_ := v;
    for l in select * from jt.prep_order_lines where order_id = ord and variant_id = k::bigint and dest = 'shopify' and qty_pushed > 0 loop
      exit when left_ <= 0;
      t := least(left_, l.qty_pushed);
      insert into jt.shopify_stock_moves (variant_id, delta, reason, kind, amazon_sku, order_id, created_by)
      values (l.variant_id, -t, 'received twice (Seller Sage and the Shopify PO) on ' || coalesce(nullif(o.po_no, ''), o.vendor || ' order ' || ord),
              'double_fix', l.amazon_sku, ord, coalesce(p->>'by', ''));
      update jt.prep_order_lines set qty_pushed = qty_pushed - t where order_id = ord and variant_id = l.variant_id and amazon_sku = l.amazon_sku and dest = 'shopify';
      left_ := left_ - t; n := n + t;
    end loop;
  end loop;
  update jt.prep_orders set recv_double = '{}'::jsonb, updated_at = now() where id = ord;
  if n > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    begin perform jt.dispatch_sync('fbm-inventory'); exception when others then null; end;
  end if;
  return n;
end $$;
revoke all on function jt.po_fix_double(jsonb) from public;
create or replace function public.jt_po_fix_double(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_fix_double(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_po_fix_double(jsonb) from public, anon;
grant execute on function public.jt_po_fix_double(jsonb) to authenticated;
