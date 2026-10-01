-- The invoice PDF goes onto its QuickBooks bill as an attachment (the `qbo` edge function: on create_bill, and
-- action attach for bills entered earlier). Attached once: qbo_attach_id remembers it.

alter table jt.invoices add column if not exists qbo_attach_id text;
alter table jt.invoices add column if not exists qbo_attach_at timestamptz;

-- the stored PDF: {name, type, parts: [base64, ...]} (each part is base64 on its own), or null
create or replace function public.jt_qbo_invoice_file(inv bigint) returns jsonb
language sql security definer set search_path = '' as $$
  select case when i.file_parts > 0 then jsonb_build_object('name', i.file_name, 'type', i.file_type,
    'parts', (select jsonb_agg(f.data order by f.part) from jt.invoice_files f where f.invoice_id = i.id)) end
  from jt.invoices i where i.id = inv;
$$;
create or replace function public.jt_qbo_attached(inv bigint, att text) returns void
language sql security definer set search_path = '' as $$
  update jt.invoices set qbo_attach_id = att, qbo_attach_at = case when att is null then null else now() end where id = inv;
$$;
revoke all on function public.jt_qbo_invoice_file(bigint), public.jt_qbo_attached(bigint, text) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_qbo_invoice_file(bigint), public.jt_qbo_attached(bigint, text) to service_role;
  end if;
end $$;

-- the bill data now says whether there's a PDF and whether it's attached
create or replace function public.jt_qbo_bill_data(inv bigint) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'vendor', coalesce(nullif(o.vendor, ''), i.vendor), 'invoice_no', i.invoice_no, 'invoice_date', i.invoice_date, 'due_date', i.due_date,
    'terms', i.terms, 'total', i.total, 'po_no', o.po_no, 'order_id', o.id, 'qbo_bill_id', i.qbo_bill_id, 'qbo_doc', i.qbo_doc,
    'qbo_attach_id', i.qbo_attach_id, 'has_file', i.file_parts > 0,
    'qbo_vendor', (select jsonb_build_object('id', v.qbo_id, 'name', v.qbo_name) from jt.qbo_vendors v where v.vendor = coalesce(nullif(o.vendor, ''), i.vendor)),
    'accounts', (select value from jt.settings where key = 'qbo_accounts'),
    'by_account', (select coalesce(jsonb_object_agg(a, amt), '{}'::jsonb) from (
        select coalesce(nullif(l.account, ''), 'inventory') as a, round(sum(coalesce(l.amount, coalesce(l.qty, 0) * coalesce(l.unit_cost, 0))), 2) as amt
        from jt.invoice_lines l where l.invoice_id = i.id group by 1) s))
  from jt.invoices i left join jt.prep_orders o on o.id = i.order_id
  where i.id = inv;
$$;

-- unlinking a bill forgets its attachment too
create or replace function jt.invoice_qbo_unlink(p jsonb) returns void
language sql security definer set search_path = '' as $$
  update jt.invoices set qbo_bill_id = null, qbo_doc = null, qbo_sent_at = null, qbo_sent_by = '', qbo_how = '', qbo_attach_id = null, qbo_attach_at = null
  where id = (p->>'invoice_id')::bigint;
$$;
