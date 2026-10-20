-- "Missing invoice" orders (Brian, Oct 20: "From a new order we should also be able to flag 'missing invoice' to cover
-- the case when stuff arrives and there is no data in the system.")
--   * prep_orders.missing_invoice (+ when / by): goods came in with nothing in the system. Made from Start an order ›
--     missing invoice (vendor required; created Ordered so it can be received right away), or flagged on any open PO.
--   * Cleared by itself when an invoice is put on the PO (trigger on jt.invoices.order_id), or by hand.

alter table jt.prep_orders add column if not exists missing_invoice boolean not null default false;
alter table jt.prep_orders add column if not exists missing_invoice_at timestamptz;
alter table jt.prep_orders add column if not exists missing_invoice_by text not null default '';

create or replace function jt.po_missing_invoice_create(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare ord bigint; v text := btrim(coalesce(p->>'vendor', ''));
begin
  if v = '' then raise exception 'pick the vendor'; end if;
  insert into jt.prep_orders (vendor, po_no, category, note, status, created_by, stage_at, receive_into,
                              missing_invoice, missing_invoice_at, missing_invoice_by)
  values (v, btrim(coalesce(p->>'po_no', '')), btrim(coalesce(p->>'category', '')), coalesce(p->>'note', ''), 'ordered', coalesce(p->>'by', ''),
          jsonb_build_object('draft', now(), 'ordered', now()),
          case when p->>'receive_into' in ('shopify', 'prep', 'both') then p->>'receive_into' else 'shopify' end,
          true, now(), coalesce(p->>'by', ''))
  returning id into ord;
  return ord;
end $$;
revoke all on function jt.po_missing_invoice_create(jsonb) from public;

-- p = {id, on: true|false}
create or replace function jt.po_flag_missing_invoice(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare yes boolean := coalesce((p->>'on')::boolean, true);
begin
  update jt.prep_orders set missing_invoice = yes,
    missing_invoice_at = case when yes then now() else missing_invoice_at end,
    missing_invoice_by = case when yes then coalesce(p->>'by', '') else missing_invoice_by end, updated_at = now()
  where id = (p->>'id')::bigint;
  if not found then raise exception 'purchase order % not found', p->>'id'; end if;
  return yes;
end $$;
revoke all on function jt.po_flag_missing_invoice(jsonb) from public;

-- an invoice landing on the PO clears the flag
create or replace function jt.trg_invoice_clears_missing() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.order_id is not null and new.order_id is distinct from old.order_id then
    update jt.prep_orders set missing_invoice = false where id = new.order_id and missing_invoice;
  end if;
  return null;
end $$;
create or replace function jt.trg_invoice_clears_missing_ins() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.order_id is not null then update jt.prep_orders set missing_invoice = false where id = new.order_id and missing_invoice; end if;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'invoice_clears_missing') then
    create trigger invoice_clears_missing after update of order_id on jt.invoices
      for each row execute function jt.trg_invoice_clears_missing();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'invoice_clears_missing_ins') then
    create trigger invoice_clears_missing_ins after insert on jt.invoices
      for each row execute function jt.trg_invoice_clears_missing_ins();
  end if;
end $$;

create or replace function public.jt_po_missing_invoice_create(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_missing_invoice_create(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_po_flag_missing_invoice(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_flag_missing_invoice(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_po_missing_invoice_create(jsonb), public.jt_po_flag_missing_invoice(jsonb) from public, anon;
grant execute on function public.jt_po_missing_invoice_create(jsonb), public.jt_po_flag_missing_invoice(jsonb) to authenticated;
