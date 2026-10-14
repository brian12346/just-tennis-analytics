-- Invoices without a PO (Brian, Oct 14): "We often get the invoice first" — an invoice can be read and saved on its
-- own, then used to build the Shopify PO (Shopify import CSV from the invoice), and it attaches itself to the Seller
-- Sage PO when that Shopify PO syncs in.
--
-- jt.invoice_save_alone(p): save (or update) an invoice that isn't on a purchase order — the same body as one
--   invoice in jt.po_save, plus 'remember' (vendor item codes -> variants). Costs aren't queued for Shopify
--   (update_cost false), as on the PO page. Refused for an invoice that's on a PO (that one saves with its PO).
-- jt.po_attach_invoices(ord): an unlinked invoice from the last 180 days whose products are exactly the PO's products
--   goes onto that PO (only when exactly one fits), and a draft/ordered PO moves to invoiced. Called whenever a Shopify
--   PO gets its Seller Sage PO (auto-import or link). The trigger is deferred to the end of the transaction: the
--   import sets ss_order_id before it saves the PO's lines.
create or replace function jt.invoice_save_alone(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare inv bigint := nullif(p->>'id', '')::bigint; body jsonb;
begin
  if inv is not null and exists (select 1 from jt.invoices i where i.id = inv
       and (i.order_id is not null or exists (select 1 from jt.prep_orders o where o.invoice_id = i.id))) then
    raise exception 'invoice % is on a purchase order; save it with its PO', inv;
  end if;
  body := p - 'remember' || jsonb_build_object('lines', coalesce((select jsonb_agg(e || '{"update_cost": false}'::jsonb order by n)
                                                                  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality x(e, n)), '[]'::jsonb));
  if inv is null then body := body || '{"stage": "new"}'::jsonb; end if;
  inv := jt.save_invoice(body);
  perform jt.invoice_set_payment(inv, p - 'id' - 'lines' - 'remember');
  perform jt.remember_vendor_items(jsonb_build_object('vendor', coalesce(p->>'vendor', ''), 'items', coalesce(p->'remember', '[]'::jsonb)));
  return inv;
end $$;
revoke all on function jt.invoice_save_alone(jsonb) from public;

create or replace function public.jt_invoice_save_alone(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_save_alone(p);
end $$;
revoke all on function public.jt_invoice_save_alone(jsonb) from public, anon;
grant execute on function public.jt_invoice_save_alone(jsonb) to authenticated;

create or replace function jt.po_attach_invoices(ord bigint) returns integer
language plpgsql security definer set search_path = '' as $$
declare po_set bigint[]; hits bigint[]; st text;
begin
  select coalesce(array_agg(distinct variant_id order by variant_id), '{}') into po_set from jt.prep_order_lines where order_id = ord and qty_ordered > 0;
  if cardinality(po_set) = 0 then return 0; end if;
  select coalesce(array_agg(i.id order by i.id), '{}') into hits
  from jt.invoices i
  where i.order_id is null and not exists (select 1 from jt.prep_orders o where o.invoice_id = i.id)
    and i.created_at > now() - interval '180 days'
    and (select coalesce(array_agg(distinct l.variant_id order by l.variant_id), '{}') from jt.invoice_lines l
         where l.invoice_id = i.id and l.variant_id is not null and coalesce(l.match_how, '') <> 'skip') = po_set;
  if cardinality(hits) <> 1 then return 0; end if;
  perform jt.invoice_move(jsonb_build_object('invoice_id', hits[1], 'order_id', ord));
  select status into st from jt.prep_orders where id = ord;
  if st in ('draft', 'ordered') then perform jt.prep_order_status(jsonb_build_object('id', ord, 'status', 'invoiced', 'by', 'Shopify (auto)')); end if;
  return 1;
end $$;
revoke all on function jt.po_attach_invoices(bigint) from public;

create or replace function jt.trg_po_attach_invoices() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.ss_order_id is not null and old.ss_order_id is distinct from new.ss_order_id then
    perform jt.po_attach_invoices(new.ss_order_id);
  end if;
  return new;
end $$;
drop trigger if exists po_attach_invoices on jt.shopify_pos;
create constraint trigger po_attach_invoices after update of ss_order_id on jt.shopify_pos
  deferrable initially deferred for each row execute function jt.trg_po_attach_invoices();
