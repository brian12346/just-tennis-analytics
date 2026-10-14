-- To do list: "archive it in Shopify" once per product, not per size (Wilson's portal pull marked ~200 sold-out sizes;
-- a product is archived as a whole). Suggested when every active size of the product is discontinued and nothing is
-- left in the store, prep center or Amazon.
create or replace function jt.todo_suggestions()
returns table (key text, kind text, title text, link text, detail text, since timestamptz)
language sql stable security definer set search_path = '' as $$
  with po as (
    select o.id, o.vendor, o.status, o.approved_at, o.created_at, o.updated_at,
           case when o.po_no ~* '^\s*po' then o.po_no else 'PO ' || coalesce(nullif(o.po_no, ''), '#' || o.id) end as name
    from jt.prep_orders o where o.status = 'draft'),
  iv as (
    select i.id, i.vendor, i.invoice_no, i.created_at, i.received_at, i.qbo_bill_id,
           coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1)) as oid,
           (select count(*) from jt.invoice_lines l where l.invoice_id = i.id and ((l.variant_id is null and l.match_how <> 'skip') or l.match_how like 'guess%')) as issues,
           (select coalesce(sum(l.qty), 0) from jt.invoice_lines l where l.invoice_id = i.id and l.variant_id is not null and l.match_how <> 'skip') as billed
    from jt.invoices i where i.created_at > now() - interval '120 days'),
  disc as (   -- per product: every size discontinued and nothing left anywhere, still active in Shopify
    select v.product_id, max(v.product_title) as title, min(s.disc_since) as disc_since
    from jt.variants v left join jt.product_status s on s.variant_id = v.variant_id
    left join jt.v_variant_stock st on st.variant_id = v.variant_id
    where v.removed_at is null and v.status = 'ACTIVE'
    group by v.product_id
    having bool_and(coalesce(s.discontinued, false)) and sum(coalesce(st.store, 0) + coalesce(st.prep, 0) + coalesce(st.amazon, 0)) = 0)
  select 'approve:' || id, 'approve', 'Approve ' || vendor || ' ' || name, 'po:' || id, 'Order ready to approve', created_at from po where approved_at is null
  union all
  select 'submit:' || id, 'submit', 'Give ' || vendor || ' ' || name || ' to the vendor', 'po:' || id, 'Approved — mark it ordered once it''s placed', approved_at from po where approved_at is not null
  union all
  select 'invfix:' || id, 'invfix', 'Fix invoice ' || coalesce(nullif(invoice_no, ''), '#' || id) || ' from ' || vendor, 'invoice:' || id,
         issues || ' line' || case when issues = 1 then '' else 's' end || ' to check', created_at from iv where issues > 0
  union all
  select 'invpo:' || id, 'invpo', 'Build the PO for ' || vendor || ' invoice ' || coalesce(nullif(invoice_no, ''), '#' || id), 'invoice:' || id,
         'No PO yet — Shopify import CSV', created_at from iv where issues = 0 and oid is null
  union all
  select 'receive:' || id, 'receive', 'Receive ' || vendor || ' invoice ' || coalesce(nullif(invoice_no, ''), '#' || id), 'invoice:' || id,
         billed::int || ' unit' || case when billed = 1 then '' else 's' end || ' to receive', created_at from iv where issues = 0 and oid is not null and received_at is null and billed > 0
  union all
  select 'qbo:' || id, 'qbo', 'Enter ' || vendor || ' bill ' || coalesce(nullif(invoice_no, ''), '#' || id) || ' in QuickBooks', 'invoice:' || id,
         'Received, not in QuickBooks', received_at from iv where issues = 0 and oid is not null and received_at is not null and qbo_bill_id is null
  union all
  select 'discont:' || product_id, 'discont', 'Archive ' || title || ' in Shopify', 'discontinued',
         'Discontinued' || coalesce(' since ' || to_char(disc_since, 'Mon FMDD'), '') || ' and sold out everywhere', disc_since::timestamptz from disc
$$;
