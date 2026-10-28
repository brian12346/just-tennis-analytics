-- Invoice lines can be put in any order on the invoice page (Brian, Oct 28: "make sure we can move items up and down
-- on the invoice"), with "Match vendor invoice" putting them back in the vendor's order. line_no stays the order on the
-- page; vendor_no is the line's place on the vendor's invoice (as read from the PDF). Lines saved before this have
-- none: their line_no is the vendor's order, so it's copied in.
alter table jt.invoice_lines add column if not exists vendor_no integer;
update jt.invoice_lines set vendor_no = line_no where vendor_no is null;

-- jt.save_invoice writes vendor_no (sent per line; else its place in the list). Patched in place; runs once.
do $$
declare d text := pg_get_functiondef('jt.save_invoice(jsonb)'::regprocedure);
        a1 text := 'variant_id, match_how, update_cost, new_price, dest, amazon_sku, account)';
        a2 text := E'case when x.e->>''account'' = ''inbound_shipping'' then ''inbound_shipping'' else ''inventory'' end\n  from jsonb_array_elements';
begin
  if position('vendor_no' in d) > 0 then return; end if;
  if position(a1 in d) = 0 or position(a2 in d) = 0 then raise exception 'jt.save_invoice changed; update migration 171'; end if;
  d := replace(d, a1, 'variant_id, match_how, update_cost, new_price, dest, amazon_sku, account, vendor_no)');
  d := replace(d, a2, E'case when x.e->>''account'' = ''inbound_shipping'' then ''inbound_shipping'' else ''inventory'' end,\n         coalesce(nullif(x.e->>''vendor_no'', '''')::int, x.n::int)\n  from jsonb_array_elements');
  execute d;
end $$;
