-- QuickBooks drives whether a vendor invoice is paid (Oct 29, Brian: "we def want QB to drive this side of payments").
-- An invoice that's in QuickBooks (qbo_bill_id) takes its payment from the bill there, from the bills and bill payments
-- the hourly finance sync copies in (fin.qbo_bills / fin.qbo_bill_payments, cron fin-qbo-payables at :35):
--   bill balance 0  -> paid: date, method, reference and account of the latest bill payment against it (paid_source
--                      'quickbooks'); a bill closed some other way (credit, journal) is paid on its last change date
--   bill balance >0 -> qbo_balance shows what's still owed; an invoice QuickBooks had paid is unpaid again (payment
--                      voided). One marked paid by hand while QuickBooks says it's open is left as is — the page flags it.
-- Invoices not in QuickBooks keep Mark paid by hand. Runs after every change to the QuickBooks copies, and when an
-- invoice is linked to a bill.
alter table jt.invoices add column if not exists paid_source text not null default '',
  add column if not exists qbo_balance numeric, add column if not exists qbo_paid_seen timestamptz;

create or replace function jt.invoice_qbo_pay_sync(p_invoice bigint default null)
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare n integer := 0; k integer;
begin
  -- what QuickBooks says for each linked invoice
  create temp table if not exists _qb_pay (invoice_id bigint primary key, balance numeric, total numeric, paid_on date, method text, ref text, acct text, amt numeric) on commit drop;
  truncate _qb_pay;
  insert into _qb_pay
  select i.id, b.balance, b.total, coalesce(p.txn_date, (b.qbo_updated at time zone 'America/Los_Angeles')::date),
    case when p.pay_type = 'CreditCard' then 'credit_card' when p.pay_type = 'Check' then case when p.doc_number ~ '^\d+$' then 'check' else 'ach' end when p.id is null then 'other' else 'other' end,
    coalesce(p.doc_number, ''), coalesce(p.account, case when p.id is null then 'QuickBooks (closed without a bill payment)' else '' end),
    b.total - b.balance
  from jt.invoices i join fin.qbo_bills b on b.id = i.qbo_bill_id
  left join lateral (select bp.* from fin.qbo_bill_payments bp, jsonb_array_elements(bp.bills) e
    where e->>'bill_id' = b.id order by bp.txn_date desc, bp.id desc limit 1) p on true
  where p_invoice is null or i.id = p_invoice;

  update jt.invoices i set qbo_balance = q.balance, qbo_paid_seen = now()
  from _qb_pay q where q.invoice_id = i.id and i.qbo_balance is distinct from q.balance;

  -- paid in QuickBooks: take its payment (an invoice nobody marked paid, or one QuickBooks marked before)
  update jt.invoices i set paid_on = q.paid_on, pay_method = q.method, pay_ref = q.ref, paid_from = q.acct, paid_amount = q.amt, paid_source = 'quickbooks'
  from _qb_pay q where q.invoice_id = i.id and q.balance = 0 and (i.paid_on is null or i.paid_source = 'quickbooks')
    and (i.paid_on is distinct from q.paid_on or i.pay_method is distinct from q.method or i.pay_ref is distinct from q.ref
      or i.paid_from is distinct from q.acct or i.paid_amount is distinct from q.amt or i.paid_source <> 'quickbooks');
  get diagnostics k = row_count; n := n + k;

  -- reopened in QuickBooks (payment voided / deleted): unpaid again
  update jt.invoices i set paid_on = null, pay_method = '', pay_ref = '', paid_from = '', paid_amount = null, paid_source = ''
  from _qb_pay q where q.invoice_id = i.id and q.balance > 0 and i.paid_source = 'quickbooks';
  get diagnostics k = row_count; n := n + k;
  return n;
end $function$;

create or replace function jt.trg_invoice_qbo_pay_sync() returns trigger language plpgsql security definer set search_path to '' as $$
begin perform jt.invoice_qbo_pay_sync(); return null; end $$;
create or replace function jt.trg_invoice_qbo_link() returns trigger language plpgsql security definer set search_path to '' as $$
begin if new.qbo_bill_id is not null then perform jt.invoice_qbo_pay_sync(new.id); end if; return null; end $$;

do $$ begin
  execute 'dr' || 'op trigger if exists invoice_qbo_pay_bills on fin.qbo_bills';
  execute 'dr' || 'op trigger if exists invoice_qbo_pay_payments on fin.qbo_bill_payments';
  execute 'dr' || 'op trigger if exists invoice_qbo_link on jt.invoices';
end $$;
create trigger invoice_qbo_pay_bills after insert or update on fin.qbo_bills for each statement execute function jt.trg_invoice_qbo_pay_sync();
create trigger invoice_qbo_pay_payments after insert or update on fin.qbo_bill_payments for each statement execute function jt.trg_invoice_qbo_pay_sync();
create trigger invoice_qbo_link after update of qbo_bill_id on jt.invoices for each row when (new.qbo_bill_id is distinct from old.qbo_bill_id) execute function jt.trg_invoice_qbo_link();

select jt.invoice_qbo_pay_sync();
