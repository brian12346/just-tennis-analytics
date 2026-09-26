-- Invoices board: every invoice sits in a workflow stage (a lane on the Invoices tab) and can be moved between
-- stages at any time, including after its costs were applied. Stage keys are defined in dashboard/src/js/invoices.js.

alter table jt.invoices add column if not exists stage text not null default 'new';
alter table jt.invoices add column if not exists stage_at timestamptz not null default now();
alter table jt.invoices add column if not exists po_no text not null default '';
create index if not exists invoices_stage_idx on jt.invoices (stage);

-- Save keeps stage and PO # (new invoices can be created in any stage, e.g. a booking order with no lines yet).
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
      stage_at = case when stage is distinct from coalesce(nullif(p->>'stage', ''), stage) then now() else stage_at end,
      stage = coalesce(nullif(p->>'stage', ''), stage), updated_at = now()
    where id = v_id;
    delete from jt.invoice_lines where invoice_id = v_id;
  else
    insert into jt.invoices (vendor, invoice_no, invoice_date, file_name, subtotal, notes, po_no, stage)
    values (coalesce(p->>'vendor', ''), coalesce(p->>'invoice_no', ''), nullif(p->>'invoice_date', '')::date,
            coalesce(p->>'file_name', ''), nullif(p->>'subtotal', '')::numeric, coalesce(p->>'notes', ''),
            coalesce(p->>'po_no', ''), coalesce(nullif(p->>'stage', ''), 'new'))
    returning id into v_id;
  end if;
  insert into jt.invoice_lines (invoice_id, line_no, item_code, upc, description, qty, unit_cost, amount,
                                variant_id, match_how, update_cost, new_price)
  select v_id, x.n::int, coalesce(x.e->>'item_code', ''), coalesce(x.e->>'upc', ''), coalesce(x.e->>'description', ''),
         nullif(x.e->>'qty', '')::numeric, nullif(x.e->>'unit_cost', '')::numeric, nullif(x.e->>'amount', '')::numeric,
         nullif(x.e->>'variant_id', '')::bigint, coalesce(x.e->>'match_how', ''),
         coalesce((x.e->>'update_cost')::boolean, true), nullif(x.e->>'new_price', '')::numeric
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) with ordinality x(e, n);
  return v_id;
end $$;

-- Card fields that stay editable after an invoice is applied: p = {id, stage?, notes?, po_no?}
create or replace function jt.update_invoice_card(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare v_id bigint := (p->>'id')::bigint;
begin
  update jt.invoices set
    stage_at = case when p ? 'stage' and stage is distinct from p->>'stage' then now() else stage_at end,
    stage = case when p ? 'stage' and coalesce(p->>'stage', '') <> '' then p->>'stage' else stage end,
    notes = case when p ? 'notes' then coalesce(p->>'notes', '') else notes end,
    po_no = case when p ? 'po_no' then coalesce(p->>'po_no', '') else po_no end,
    updated_at = now()
  where id = v_id;
  return found;
end $$;
revoke all on function jt.update_invoice_card(jsonb) from public;

create or replace function public.jt_update_invoice_card(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.update_invoice_card(p);
end $$;
revoke all on function public.jt_update_invoice_card(jsonb) from public, anon;
grant execute on function public.jt_update_invoice_card(jsonb) to authenticated;
