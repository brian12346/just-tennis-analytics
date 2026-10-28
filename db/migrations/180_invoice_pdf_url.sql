-- An invoice can carry a link to its PDF (Brian, Oct 29: invoices parsed outside Seller Sage come in as a CSV "with a
-- link to a pdf"). Shown on the invoice page as "Vendor PDF ↗". p = {id, pdf_url}
alter table jt.invoices add column if not exists pdf_url text not null default '';
create or replace function jt.invoice_set_pdf_url(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update jt.invoices set pdf_url = btrim(coalesce(p->>'pdf_url', '')), updated_at = now() where id = (p->>'id')::bigint;
  if not found then raise exception 'invoice % not found', p->>'id'; end if;
  return true;
end $$;
create or replace function public.jt_invoice_set_pdf_url(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_set_pdf_url(p);
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.invoice_set_pdf_url(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_invoice_set_pdf_url(jsonb) from public, anon';
  execute 'grant execute on function public.jt_invoice_set_pdf_url(jsonb) to authenticated';
end $$;
