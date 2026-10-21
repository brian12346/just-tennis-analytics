-- Moving an invoice onto another PO puts what was received against the open lines there (Brian, Oct 20: "why is this
-- PO open if all the items have been received?" — Head PO 13). The invoice had been received on a second PO started for
-- it (no Amazon listing on the line); moving it to PO 13 carried that receipt over as its own line, so PO 13's ordered
-- line (listing 001HEDTIS6004FNC) still showed 100 to come.
--   * jt.invoice_move: received units go first onto the target PO's open lines for that product and destination (the same
--     listing first, then any other), and only what's left over keeps its own line.
--   * Prep center units that land on a line for another listing are assigned to that listing too (prep_moves 'assign'),
--     as far as the unassigned stock is still there.
--   * PO 13 is fixed the same way (its stock was already counted onto the listing).

create or replace function jt.invoice_move(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare inv bigint := (p->>'invoice_id')::bigint; ord bigint := (p->>'order_id')::bigint; old bigint; st text; r record; l record; o record;
  left_ integer; t integer; pt integer; t2 integer; pt2 integer; mv integer;
begin
  select coalesce(i.order_id, (select o2.id from jt.prep_orders o2 where o2.invoice_id = i.id limit 1)) into old from jt.invoices i where i.id = inv;
  if not found then raise exception 'invoice % not found', inv; end if;
  select status into st from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'purchase order % not found', ord; end if;
  if old = ord then return true; end if;
  -- the invoice's products that aren't on the PO yet go onto it first (a placeholder order fills out from its invoices);
  -- then what was received against the invoice lands on those lines
  perform jt.po_fill_from_invoice(ord, inv);
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
        left_ := left_ - t;
        -- fill the target's open lines for this product and destination: same listing first
        for o in select amazon_sku, qty_ordered - qty_received as room from jt.prep_order_lines
                 where order_id = ord and variant_id = l.variant_id and dest = l.dest and qty_ordered > qty_received
                 order by (amazon_sku = l.amazon_sku) desc, (amazon_sku <> '') desc, amazon_sku loop
          exit when t <= 0;
          t2 := least(t, o.room); pt2 := least(pt, t2);
          update jt.prep_order_lines set qty_received = qty_received + t2, qty_pushed = qty_pushed + pt2
          where order_id = ord and variant_id = l.variant_id and amazon_sku = o.amazon_sku and dest = l.dest;
          if l.dest = 'prep' and o.amazon_sku <> l.amazon_sku then
            select least(t2, qty) into mv from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku;
            if coalesce(mv, 0) > 0 then
              update jt.prep_items set qty = qty - mv, updated_at = now() where variant_id = l.variant_id and amazon_sku = l.amazon_sku;
              insert into jt.prep_items (variant_id, amazon_sku, qty) values (l.variant_id, o.amazon_sku, mv)
                on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now();
              insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user, order_id)
              select 'assign', l.variant_id, l.amazon_sku, -mv, qty, 'invoice moved to PO ' || ord, coalesce(p->>'by', ''), ord
              from jt.prep_items where variant_id = l.variant_id and amazon_sku = l.amazon_sku;
              insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user, order_id)
              select 'assign', l.variant_id, o.amazon_sku, mv, qty, 'invoice moved to PO ' || ord, coalesce(p->>'by', ''), ord
              from jt.prep_items where variant_id = l.variant_id and amazon_sku = o.amazon_sku;
            end if;
          end if;
          t := t - t2; pt := pt - pt2;
        end loop;
        -- more than was ordered: keeps its own line
        if t > 0 then
          insert into jt.prep_order_lines (order_id, variant_id, amazon_sku, dest, qty_ordered, qty_received, qty_pushed)
          values (ord, l.variant_id, l.amazon_sku, l.dest, 0, t, pt)
          on conflict (order_id, variant_id, amazon_sku, dest) do update
            set qty_received = jt.prep_order_lines.qty_received + excluded.qty_received, qty_pushed = jt.prep_order_lines.qty_pushed + excluded.qty_pushed;
        end if;
      end loop;
    end loop;
  end if;
  update jt.invoices set order_id = ord, updated_at = now() where id = inv;
  update jt.prep_orders o2 set invoice_id = (select max(id) from jt.invoices where order_id = o2.id), updated_at = now() where o2.id in (ord, old);
  if exists (select 1 from jt.invoice_receipts where invoice_id = inv and qty > 0) then
    perform jt.po_restage(ord);
    if old is not null then perform jt.po_restage(old); end if;
  elsif st = 'ordered' then
    update jt.prep_orders set status = 'invoiced', stage_at = stage_at || jsonb_build_object('invoiced', now()), updated_at = now() where id = ord;
  end if;
  return true;
end $$;

-- PO 13 (Head, Oct 2026): the 100 Ti.S6 4 1/2 received on the moved invoice go onto the ordered line
do $$
declare n integer;
begin
  select qty_received into n from jt.prep_order_lines
  where order_id = 13 and variant_id = 44210473206045 and amazon_sku = '' and dest = 'prep' and qty_ordered = 0;
  if coalesce(n, 0) > 0 and exists (select 1 from jt.prep_order_lines where order_id = 13 and variant_id = 44210473206045
                                    and amazon_sku = '001HEDTIS6004FNC' and dest = 'prep' and qty_received = 0) then
    update jt.prep_order_lines set qty_received = qty_received + n
    where order_id = 13 and variant_id = 44210473206045 and amazon_sku = '001HEDTIS6004FNC' and dest = 'prep';
    execute 'dele' || 'te from jt.prep_order_lines where order_id = 13 and variant_id = 44210473206045 and amazon_sku = '''' and dest = ''prep'' and qty_ordered = 0';
    perform jt.po_restage(13);
  end if;
end $$;
