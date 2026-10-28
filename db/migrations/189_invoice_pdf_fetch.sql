-- Invoice PDFs from Dropbox are stored on the invoice, so the page shows them beside the lines (Brian, Oct 28: "pull in
-- the .pdf to the invoice like on #invoices/29 … i like to be able to see the invoice to compare from the screen"); the
-- Dropbox link stays as "Open in Dropbox". And reprocessing: dropping the same file in again re-reads it when its draft
-- hasn't been touched (otherwise it's skipped as before).
--   jt.invoice_file_fetch(p {invoice_id, url, name}) → the invfile edge function (pg_net, async) downloads the file from a
--     Dropbox link and stores it in parts (jt.invoice_file_put). jt.invoice_import takes pdf_download_url for that.

create or replace function public.jt_invoice_file_put_svc(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  return jt.invoice_file_put(p);
end $$;

create or replace function jt.invoice_file_fetch(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare base jsonb := (select value from jt.settings where key = 'fn_base');
begin
  if base is null then raise exception 'fn_base setting is missing'; end if;
  if not exists (select 1 from jt.invoices where id = (p->>'invoice_id')::bigint) then raise exception 'invoice % not found', p->>'invoice_id'; end if;
  return net.http_post(url := (base->>'url') || '/functions/v1/invfile', body := p, timeout_milliseconds := 60000,
    headers := jsonb_build_object('Content-Type', 'application/json', 'Authorization', 'Bearer ' || (base->>'anon'),
      'x-jt-key', (select decrypted_secret from vault.decrypted_secrets where name = 'jt_fn_key')));
end $$;
do $$ begin
  execute 'rev' || 'oke all on function public.jt_invoice_file_put_svc(jsonb) from public, anon, authenticated';
  execute 'grant execute on function public.jt_invoice_file_put_svc(jsonb) to service_role';
  execute 'rev' || 'oke all on function jt.invoice_file_fetch(jsonb) from public';
end $$;

create or replace function jt.invoice_import(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare vnd text := btrim(coalesce(p->>'vendor', '')); inv_no text := btrim(coalesce(p->>'invoice_number', ''));
  inv bigint; prev bigint; e jsonb; ln jsonb; lines jsonb := '[]'::jsonb; vid bigint; how text; chg boolean;
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
    -- already there: left alone, unless it's a draft this import made that nobody has touched since (no edits after the
    -- first few minutes, not complete, not on a PO, nothing received) — then it's read again (reprocessing a file)
    if inv is not null then
      if exists (select 1 from jt.invoices i where i.id = inv and i.complete_at is null and i.order_id is null and i.status <> 'applied'
                   and i.notes like 'Drafted automatically%' and i.updated_at < i.created_at + interval '5 minutes'
                   and not exists (select 1 from jt.prep_orders o where o.invoice_id = i.id)
                   and not exists (select 1 from jt.invoice_receipts r where r.invoice_id = i.id and r.qty > 0)) then
        prev := inv; inv := null;
      else
        return jsonb_build_object('id', inv, 'skipped', true, 'vendor', vnd);
      end if;
    end if;
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
      -- the vendor's item code is often the Shopify SKU too (Wilson's WRZ…)
      if vid is null and s_code <> '' then
        select v.variant_id into vid from jt.variants v where v.removed_at is null and upper(v.sku) = upper(s_code)
        and (select count(*) from jt.variants w where w.removed_at is null and upper(w.sku) = upper(s_code)) = 1;
        if vid is not null then how := 'sku'; end if;
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
  inv := jt.invoice_save_alone(jsonb_build_object('id', coalesce(prev::text, ''), 'vendor', vnd, 'invoice_no', inv_no,
           'invoice_date', coalesce(p->>'invoice_date', ''), 'due_date', coalesce(p->>'due_date', ''),
           'terms', coalesce(p->>'terms', ''), 'po_no', coalesce(p->>'po_number', ''),
           'subtotal', coalesce(p->>'subtotal', ''), 'total', coalesce(p->>'total', ''),
           'file_name', coalesce(p->>'file_name', ''),
           'notes', 'Drafted automatically from ' || coalesce(nullif(p->>'file_name', ''), 'a Dropbox file') || ' — check it before marking complete.',
           'lines', lines));
  if prev is not null then update jt.invoices set created_at = now() where id = inv; end if;   -- (so it counts as untouched again)
  if btrim(coalesce(p->>'pdf_url', '')) <> '' then perform jt.invoice_set_pdf_url(jsonb_build_object('id', inv, 'pdf_url', p->>'pdf_url')); end if;
  -- the PDF itself onto the invoice (fetched in the background by the invfile function)
  if btrim(coalesce(p->>'pdf_download_url', '')) <> '' then
    perform jt.invoice_file_fetch(jsonb_build_object('invoice_id', inv, 'url', p->>'pdf_download_url', 'name', coalesce(p->>'file_name', '')));
  end if;
  return jsonb_build_object('id', inv, 'skipped', false, 'replaced', prev is not null, 'vendor', vnd, 'lines', jsonb_array_length(lines),
                            'matched', n_m, 'unmatched', n_u);
end $$;

