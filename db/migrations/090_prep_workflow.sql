-- Prep center workflow (Oct 2026): invoice -> expected arrival -> Amazon shipment checklist -> receiving -> closed.
--
-- 1. Each invoice has an expected arrival date (arrival_on, set by the user); it drives the Prep center's Incoming
--    shipments section. Null = not set yet (the page falls back to the PO's expected date).
-- 2. A prep shipment carries its checklist: how it's going to Amazon (placement), manual checks (counted, combined,
--    created in Seller Central), closed when Amazon has received it, and an exception state with a note to triage.
-- 3. When a PO line is marked backordered, backorder_at remembers when (the product's "last backordered").

alter table jt.invoices add column if not exists arrival_on date;

alter table jt.prep_shipments add column if not exists placement text not null default '';      -- '' | optimized | fees_ok | awd | other
alter table jt.prep_shipments add column if not exists checks jsonb not null default '{}'::jsonb;  -- {counted|combined|sc_created: {at, by}}
alter table jt.prep_shipments add column if not exists closed_at timestamptz;
alter table jt.prep_shipments add column if not exists closed_by text not null default '';
alter table jt.prep_shipments add column if not exists exception text not null default '';      -- '' = none; else what's wrong
alter table jt.prep_shipments add column if not exists exception_at timestamptz;
alter table jt.prep_shipments add column if not exists exception_by text not null default '';

-- shipments that went out more than 30 days before this existed are done
update jt.prep_shipments set closed_at = shipped_at, closed_by = 'auto (before the checklist)'
where status = 'shipped' and closed_at is null and shipped_at < now() - interval '30 days';

alter table jt.prep_order_lines add column if not exists backorder_at timestamptz;
update jt.prep_order_lines l set backorder_at = o.updated_at from jt.prep_orders o
where o.id = l.order_id and l.backorder and l.backorder_at is null;
create or replace function jt.prep_order_lines_backorder_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.backorder and (tg_op = 'INSERT' or not coalesce(old.backorder, false)) then new.backorder_at := now(); end if;
  return new;
end $$;
drop trigger if exists prep_order_lines_backorder_at on jt.prep_order_lines;
create trigger prep_order_lines_backorder_at before insert or update of backorder on jt.prep_order_lines
  for each row execute function jt.prep_order_lines_backorder_at();

-- p = {id, arrival_on: 'YYYY-MM-DD' | null}
create or replace function jt.invoice_set_arrival(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update jt.invoices set arrival_on = nullif(p->>'arrival_on', '')::date, updated_at = now() where id = (p->>'id')::bigint;
  if not found then raise exception 'invoice % not found', p->>'id'; end if;
  return true;
end $$;
revoke all on function jt.invoice_set_arrival(jsonb) from public;

-- p = {id, placement?, check?: {key: true|false}, close?: true|false, exception?: text ('' clears), by}
create or replace function jt.prep_ship_flow(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p->>'id')::bigint; s record; k text; who text := coalesce(p->>'by', '');
begin
  select * into s from jt.prep_shipments where id = sid for update;
  if s.id is null then raise exception 'shipment % not found', sid; end if;
  if p ? 'placement' then
    if coalesce(p->>'placement', '') not in ('', 'optimized', 'fees_ok', 'awd', 'other') then raise exception 'unknown placement %', p->>'placement'; end if;
    update jt.prep_shipments set placement = coalesce(p->>'placement', ''), updated_at = now() where id = sid;
  end if;
  if jsonb_typeof(p->'check') = 'object' then
    for k in select jsonb_object_keys(p->'check') loop
      if k not in ('counted', 'combined', 'sc_created') then raise exception 'unknown check %', k; end if;
      update jt.prep_shipments set checks = case when coalesce((p->'check'->>k)::boolean, false)
          then checks || jsonb_build_object(k, jsonb_build_object('at', now(), 'by', who)) else checks - k end, updated_at = now()
      where id = sid;
    end loop;
  end if;
  if p ? 'close' then
    if coalesce((p->>'close')::boolean, false) then
      if s.status <> 'shipped' then raise exception 'mark the shipment shipped before closing it'; end if;
      update jt.prep_shipments set closed_at = now(), closed_by = who, updated_at = now() where id = sid;
    else
      update jt.prep_shipments set closed_at = null, closed_by = '', updated_at = now() where id = sid;
    end if;
  end if;
  if p ? 'exception' then
    update jt.prep_shipments set exception = coalesce(p->>'exception', ''),
      exception_at = case when coalesce(p->>'exception', '') = '' then null else now() end,
      exception_by = case when coalesce(p->>'exception', '') = '' then '' else who end, updated_at = now()
    where id = sid;
  end if;
  return (select to_jsonb(x) - 'note' from jt.prep_shipments x where id = sid);
end $$;
revoke all on function jt.prep_ship_flow(jsonb) from public;

create or replace function public.jt_invoice_set_arrival(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_set_arrival(p);
end $$;
create or replace function public.jt_prep_ship_flow(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_ship_flow(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_invoice_set_arrival(jsonb), public.jt_prep_ship_flow(jsonb) from public, anon;
grant execute on function public.jt_invoice_set_arrival(jsonb), public.jt_prep_ship_flow(jsonb) to authenticated;
