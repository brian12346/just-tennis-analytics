-- Drafts an invoice from a parsed file (Brian, Oct 28: "set up a task to read a dropbox folder and automatically create
-- a draft invoice from a file"). The hourly task reads each PDF in Dropbox, parses it into the invoice-CSV template
-- shape (claude/invoice-csv-template.md) and calls this. It makes a standalone Draft invoice — never linked to a PO,
-- never received, never sent to QuickBooks — so Brian checks it and links it himself.
-- p = {vendor, invoice_number, invoice_date, due_date, terms, po_number, subtotal, total, pdf_url, file_name,
--      lines: [{line_type, item_code, upc, shopify_sku, description, qty, unit_cost, amount}]}
-- Returns {id, skipped, lines, matched, unmatched}; skipped = true (with the existing id) when vendor + number exist.
create or replace function jt.invoice_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare vnd text := btrim(coalesce(p->>'vendor', '')); inv_no text := btrim(coalesce(p->>'invoice_number', ''));
  inv bigint; e jsonb; ln jsonb; lines jsonb := '[]'::jsonb; vid bigint; how text; chg boolean;
  n_m integer := 0; n_u integer := 0; s_sku text; s_code text; s_upc text;
begin
  if vnd = '' then raise exception 'vendor is required'; end if;
  -- use the vendor's spelling already in the system (Wilson, not WILSON SPORTING GOODS if it starts the same)
  select x.v into vnd from (select distinct vendor v from jt.prep_orders union select distinct vendor from jt.invoices
                            union select distinct vendor from jt.vendor_items) x
  where lower(x.v) = lower(vnd) or lower(vnd) like lower(x.v) || ' %' order by length(x.v) desc limit 1;
  vnd := coalesce(vnd, btrim(p->>'vendor'));
  if inv_no <> '' then
    select id into inv from jt.invoices where lower(vendor) = lower(vnd) and lower(btrim(invoice_no)) = lower(inv_no) limit 1;
    if inv is not null then return jsonb_build_object('id', inv, 'skipped', true, 'vendor', vnd); end if;
  end if;
  for e in select x from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) x loop
    chg := lower(coalesce(e->>'line_type', 'product')) in ('charge', 'freight', 'shipping', 'fee');
    s_sku := btrim(coalesce(e->>'shopify_sku', '')); s_code := btrim(coalesce(e->>'item_code', ''));
    s_upc := regexp_replace(coalesce(e->>'upc', ''), '\D', '', 'g');
    vid := null; how := '';
    if chg then how := 'skip';
    else
      if s_sku <> '' then
        select v.variant_id into vid from jt.variants v where v.removed_at is null and v.sku = s_sku
        and (select count(*) from jt.variants w where w.removed_at is null and w.sku = s_sku) = 1;
        if vid is not null then how := 'sku'; end if;
      end if;
      if vid is null and s_code <> '' then
        select vi.variant_id into vid from jt.vendor_items vi where lower(vi.vendor) = lower(vnd) and vi.item_code = s_code limit 1;
        if vid is not null then how := 'remembered'; end if;
      end if;
      if vid is null and s_upc <> '' then
        select v.variant_id into vid from jt.variants v where v.removed_at is null and ltrim(v.barcode, '0') = ltrim(s_upc, '0')
        and (select count(*) from jt.variants w where w.removed_at is null and ltrim(w.barcode, '0') = ltrim(s_upc, '0')) = 1;
        if vid is not null then how := 'upc'; end if;
      end if;
      if vid is null then n_u := n_u + 1; else n_m := n_m + 1; end if;
    end if;
    ln := jsonb_build_object('item_code', s_code, 'upc', s_upc, 'description', coalesce(e->>'description', ''),
            'qty', coalesce(e->>'qty', ''), 'unit_cost', coalesce(e->>'unit_cost', ''), 'amount', coalesce(e->>'amount', ''),
            'variant_id', coalesce(vid::text, ''), 'match_how', how)
          || case when chg then '{"account": "inbound_shipping"}'::jsonb else '{}'::jsonb end;
    lines := lines || jsonb_build_array(ln);
  end loop;
  inv := jt.invoice_save_alone(jsonb_build_object('vendor', vnd, 'invoice_no', inv_no,
           'invoice_date', coalesce(p->>'invoice_date', ''), 'due_date', coalesce(p->>'due_date', ''),
           'terms', coalesce(p->>'terms', ''), 'po_no', coalesce(p->>'po_number', ''),
           'subtotal', coalesce(p->>'subtotal', ''), 'total', coalesce(p->>'total', ''),
           'file_name', coalesce(p->>'file_name', ''),
           'notes', 'Drafted automatically from ' || coalesce(nullif(p->>'file_name', ''), 'a Dropbox file') || ' — check it before marking complete.',
           'lines', lines));
  if btrim(coalesce(p->>'pdf_url', '')) <> '' then perform jt.invoice_set_pdf_url(jsonb_build_object('id', inv, 'pdf_url', p->>'pdf_url')); end if;
  return jsonb_build_object('id', inv, 'skipped', false, 'vendor', vnd, 'lines', jsonb_array_length(lines),
                            'matched', n_m, 'unmatched', n_u);
end $$;

create or replace function public.jt_invoice_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_import(p);
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.invoice_import(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_invoice_import(jsonb) from public, anon';
  execute 'grant execute on function public.jt_invoice_import(jsonb) to authenticated';
end $$;
