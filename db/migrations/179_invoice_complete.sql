-- An invoice is a Draft until it's marked Complete (Brian, Oct 29: "let it be in a draft form or complete"). Complete
-- means it's been checked against the vendor's invoice: the page locks it (Reopen as draft to change it) and it can go
-- to QuickBooks. Invoices already in QuickBooks start out complete. p = {id, on, by}
alter table jt.invoices add column if not exists complete_at timestamptz;
alter table jt.invoices add column if not exists complete_by text not null default '';
update jt.invoices set complete_at = coalesce(qbo_sent_at, updated_at, now()), complete_by = 'already in QuickBooks'
where qbo_bill_id is not null and complete_at is null;

create or replace function jt.invoice_set_complete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare on_ boolean := coalesce((p->>'on')::boolean, true);
begin
  update jt.invoices set complete_at = case when on_ then now() end, complete_by = case when on_ then coalesce(p->>'by', '') else '' end, updated_at = now()
  where id = (p->>'id')::bigint;
  if not found then raise exception 'invoice % not found', p->>'id'; end if;
  return on_;
end $$;
create or replace function public.jt_invoice_set_complete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_set_complete(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.invoice_set_complete(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_invoice_set_complete(jsonb) from public, anon';
  execute 'grant execute on function public.jt_invoice_set_complete(jsonb) to authenticated';
end $$;
