-- Sending an invoice to QuickBooks as a bill (the `qbo` edge function, action create_bill).
-- A bill is entered once: the invoice keeps the QuickBooks bill it became (qbo_bill_id), and before creating one the
-- function looks for a bill with the same number for the same vendor in QuickBooks (entered by hand, say) and links
-- that instead. The vendor match (our vendor name -> QuickBooks vendor) is remembered in jt.qbo_vendors.
-- The QuickBooks accounts for the bill lines are looked up by name once and kept in jt.settings 'qbo_accounts'.

alter table jt.invoices add column if not exists qbo_bill_id text;
alter table jt.invoices add column if not exists qbo_doc text;
alter table jt.invoices add column if not exists qbo_sent_at timestamptz;
alter table jt.invoices add column if not exists qbo_sent_by text not null default '';
alter table jt.invoices add column if not exists qbo_how text not null default '';   -- created | linked

create table if not exists jt.qbo_vendors (
  vendor text primary key,                 -- the vendor name in this app (Shopify vendor)
  qbo_id text not null,
  qbo_name text not null default '',
  updated_at timestamptz not null default now()
);

-- what the edge function needs to build the bill
create or replace function public.jt_qbo_bill_data(inv bigint) returns jsonb
language sql security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', i.id, 'vendor', coalesce(nullif(o.vendor, ''), i.vendor), 'invoice_no', i.invoice_no, 'invoice_date', i.invoice_date, 'due_date', i.due_date,
    'terms', i.terms, 'total', i.total, 'po_no', o.po_no, 'order_id', o.id, 'qbo_bill_id', i.qbo_bill_id, 'qbo_doc', i.qbo_doc,
    'qbo_vendor', (select jsonb_build_object('id', v.qbo_id, 'name', v.qbo_name) from jt.qbo_vendors v where v.vendor = coalesce(nullif(o.vendor, ''), i.vendor)),
    'accounts', (select value from jt.settings where key = 'qbo_accounts'),
    'by_account', (select coalesce(jsonb_object_agg(a, amt), '{}'::jsonb) from (
        select coalesce(nullif(l.account, ''), 'inventory') as a, round(sum(coalesce(l.amount, coalesce(l.qty, 0) * coalesce(l.unit_cost, 0))), 2) as amt
        from jt.invoice_lines l where l.invoice_id = i.id group by 1) s))
  from jt.invoices i left join jt.prep_orders o on o.id = i.order_id
  where i.id = inv;
$$;

-- p = {invoice_id, bill_id, doc, how, by, vendor, vendor_id, vendor_name}
create or replace function public.jt_qbo_bill_saved(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  update jt.invoices set qbo_bill_id = p->>'bill_id', qbo_doc = p->>'doc', qbo_sent_at = now(), qbo_sent_by = coalesce(p->>'by', ''), qbo_how = coalesce(p->>'how', '')
  where id = (p->>'invoice_id')::bigint;
  if coalesce(p->>'vendor', '') <> '' and coalesce(p->>'vendor_id', '') <> '' then
    insert into jt.qbo_vendors (vendor, qbo_id, qbo_name) values (p->>'vendor', p->>'vendor_id', coalesce(p->>'vendor_name', ''))
    on conflict (vendor) do update set qbo_id = excluded.qbo_id, qbo_name = excluded.qbo_name, updated_at = now();
  end if;
end $$;

create or replace function public.jt_qbo_setting(k text, v jsonb) returns void
language sql security definer set search_path = '' as $$
  insert into jt.settings (key, value) values (k, v) on conflict (key) do update set value = excluded.value, updated_at = now();
$$;

revoke all on function public.jt_qbo_bill_data(bigint), public.jt_qbo_bill_saved(jsonb), public.jt_qbo_setting(text, jsonb) from public, anon, authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.jt_qbo_bill_data(bigint), public.jt_qbo_bill_saved(jsonb), public.jt_qbo_setting(text, jsonb) to service_role;
  end if;
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.qbo_vendors to jt_reader; end if;
end $$;

-- Unlinking an invoice from its QuickBooks bill (e.g. the bill was deleted in QuickBooks). p = {invoice_id}
create or replace function jt.invoice_qbo_unlink(p jsonb) returns void
language sql security definer set search_path = '' as $$
  update jt.invoices set qbo_bill_id = null, qbo_doc = null, qbo_sent_at = null, qbo_sent_by = '', qbo_how = '' where id = (p->>'invoice_id')::bigint;
$$;
revoke all on function jt.invoice_qbo_unlink(jsonb) from public;
create or replace function public.jt_invoice_qbo_unlink(p jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform jt.invoice_qbo_unlink(p);
end $$;
revoke all on function public.jt_invoice_qbo_unlink(jsonb) from public, anon;
grant execute on function public.jt_invoice_qbo_unlink(jsonb) to authenticated;
