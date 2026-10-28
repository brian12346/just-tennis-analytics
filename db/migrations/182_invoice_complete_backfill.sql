-- Data fix (Brian, Oct 28: "why the ready to receive is empty on the invoices page"). 179 only marked invoices already
-- in QuickBooks complete, so every other invoice that was on a PO before Draft existed sat in the new Draft lane instead
-- of Ready to receive / Complete. Those are marked complete now; standalone ones with no PO stay drafts. (Applied once.)
select set_config('jt.event_by', 'Claude (fix)', true);
update jt.invoices i set complete_at = now(), complete_by = 'Claude (fix: on a PO before Draft existed)'
where complete_at is null and created_at < '2026-10-28 07:02:55+00'
  and coalesce(i.order_id, (select p.id from jt.prep_orders p where p.invoice_id = i.id limit 1)) is not null;
