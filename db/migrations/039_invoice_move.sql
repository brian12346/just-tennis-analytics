-- Invoices are uploaded on the Invoices tab and belong to a purchase order. jt.invoice_move puts a saved invoice on
-- another PO (or links an older invoice that has none). Refused once anything was received against it, or when
-- either PO is complete. Each PO's invoice_id (its latest invoice) is kept up to date.
-- p = {invoice_id, order_id}
create or replace function jt.invoice_move(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare inv bigint := (p->>'invoice_id')::bigint; ord bigint := (p->>'order_id')::bigint; old bigint; st text;
begin
  select coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1)) into old from jt.invoices i where i.id = inv;
  if not found then raise exception 'invoice % not found', inv; end if;
  select status into st from jt.prep_orders where id = ord;
  if st is null then raise exception 'purchase order % not found', ord; end if;
  if st = 'complete' then raise exception 'that purchase order is complete'; end if;
  if old = ord then return true; end if;
  if old is not null and (select status from jt.prep_orders where id = old) = 'complete' then raise exception 'this invoice''s purchase order is complete'; end if;
  if exists (select 1 from jt.invoice_receipts where invoice_id = inv and qty > 0) then
    raise exception 'products were already received against this invoice; un-receive them first';
  end if;
  update jt.invoices set order_id = ord, updated_at = now() where id = inv;
  update jt.prep_orders o set invoice_id = (select max(id) from jt.invoices where order_id = o.id), updated_at = now() where o.id in (ord, old);
  return true;
end $$;
revoke all on function jt.invoice_move(jsonb) from public;
create or replace function public.jt_invoice_move(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_move(p);
end $$;
revoke all on function public.jt_invoice_move(jsonb) from public, anon;
grant execute on function public.jt_invoice_move(jsonb) to authenticated;
