-- Invoice money for QuickBooks: the bill's due date, total and terms, and an account on every invoice line so the
-- bill can be entered by account. Two accounts to start: 'inventory' (products) and 'inbound_shipping' (freight in).
-- Freight / shipping charges read from an invoice's totals area are saved as invoice lines too (not products,
-- match_how 'skip', account 'inbound_shipping'), so the lines add up to the invoice total.

alter table jt.invoices add column if not exists due_date date;
alter table jt.invoices add column if not exists total numeric(12,2);
alter table jt.invoices add column if not exists terms text not null default '';

alter table jt.invoice_lines add column if not exists account text not null default 'inventory';
alter table jt.invoice_lines drop constraint if exists invoice_lines_account_check;
alter table jt.invoice_lines add constraint invoice_lines_account_check check (account in ('inventory', 'inbound_shipping'));
update jt.invoice_lines set account = 'inbound_shipping'
where match_how = 'skip' and description ~* '\m(freight|shipping|handling|delivery|postage)\M';

create or replace function jt.save_invoice(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare v_id bigint := nullif(p->>'id', '')::bigint; v_status text;
begin
  if v_id is not null then
    select status into v_status from jt.invoices where id = v_id;
    if v_status is null then raise exception 'invoice % not found', v_id; end if;
    if v_status = 'applied' then raise exception 'invoice % was already applied; it can''t be changed', v_id; end if;
    update jt.invoices set vendor = coalesce(p->>'vendor', ''), invoice_no = coalesce(p->>'invoice_no', ''),
      invoice_date = nullif(p->>'invoice_date', '')::date, file_name = coalesce(p->>'file_name', file_name),
      subtotal = nullif(p->>'subtotal', '')::numeric, notes = coalesce(p->>'notes', ''), po_no = coalesce(p->>'po_no', po_no),
      due_date = case when p ? 'due_date' then nullif(p->>'due_date', '')::date else due_date end,
      total = case when p ? 'total' then nullif(p->>'total', '')::numeric else total end,
      terms = coalesce(p->>'terms', terms),
      stage_at = case when stage is distinct from coalesce(nullif(p->>'stage', ''), stage) then now() else stage_at end,
      stage = coalesce(nullif(p->>'stage', ''), stage), updated_at = now()
    where id = v_id;
    delete from jt.invoice_lines where invoice_id = v_id;
  else
    insert into jt.invoices (vendor, invoice_no, invoice_date, file_name, subtotal, notes, po_no, stage, due_date, total, terms)
    values (coalesce(p->>'vendor', ''), coalesce(p->>'invoice_no', ''), nullif(p->>'invoice_date', '')::date,
            coalesce(p->>'file_name', ''), nullif(p->>'subtotal', '')::numeric, coalesce(p->>'notes', ''),
            coalesce(p->>'po_no', ''), coalesce(nullif(p->>'stage', ''), 'new'),
            nullif(p->>'due_date', '')::date, nullif(p->>'total', '')::numeric, coalesce(p->>'terms', ''))
    returning id into v_id;
  end if;
  insert into jt.invoice_lines (invoice_id, line_no, item_code, upc, description, qty, unit_cost, amount,
                                variant_id, match_how, update_cost, new_price, dest, amazon_sku, account)
  select v_id, x.n::int, coalesce(x.e->>'item_code', ''), coalesce(x.e->>'upc', ''), coalesce(x.e->>'description', ''),
         nullif(x.e->>'qty', '')::numeric, nullif(x.e->>'unit_cost', '')::numeric, nullif(x.e->>'amount', '')::numeric,
         nullif(x.e->>'variant_id', '')::bigint, coalesce(x.e->>'match_how', ''),
         coalesce((x.e->>'update_cost')::boolean, true), nullif(x.e->>'new_price', '')::numeric,
         case when x.e->>'dest' = 'shopify' then 'shopify' else 'prep' end, coalesce(x.e->>'amazon_sku', ''),
         case when x.e->>'account' = 'inbound_shipping' then 'inbound_shipping' else 'inventory' end
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality x(e, n);
  return v_id;
end $$;
