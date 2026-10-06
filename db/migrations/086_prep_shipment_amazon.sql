-- Prep center shipments <-> Seller Central shipments. Send to Amazon splits one box plan into several FBA shipments
-- (one per fulfillment center), so a prep shipment links to one or more Amazon shipments (jt.inbound_shipments);
-- an Amazon shipment belongs to at most one prep shipment. The Prep center tab suggests links when the contents
-- match; someone confirms them (how = 'match'), or links one by hand (how = 'manual').
create table if not exists jt.prep_shipment_amazon (
  amazon_id   text primary key,                                   -- jt.inbound_shipments.id (FBA… or AWD STAR-…)
  shipment_id bigint not null references jt.prep_shipments (id) on delete cascade,
  how         text not null default 'manual',
  linked_at   timestamptz not null default now(),
  linked_by   text not null default ''
);
create index if not exists prep_shipment_amazon_ship on jt.prep_shipment_amazon (shipment_id);

-- p = {shipment_id, amazon_ids: [...], how, unlink: true|false, by}. Linking moves an Amazon shipment from any other
-- prep shipment. Returns the number of Amazon shipments linked or unlinked.
create or replace function jt.prep_ship_link(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p->>'shipment_id')::bigint; n int;
begin
  if not exists (select 1 from jt.prep_shipments where id = sid) then raise exception 'shipment % not found', sid; end if;
  if coalesce((p->>'unlink')::boolean, false) then
    delete from jt.prep_shipment_amazon where shipment_id = sid
      and (jsonb_typeof(p->'amazon_ids') is distinct from 'array' or amazon_id in (select jsonb_array_elements_text(p->'amazon_ids')));
    get diagnostics n = row_count;
    return n;
  end if;
  insert into jt.prep_shipment_amazon (amazon_id, shipment_id, how, linked_by)
  select x, sid, coalesce(nullif(p->>'how', ''), 'manual'), coalesce(p->>'by', '')
  from jsonb_array_elements_text(coalesce(p->'amazon_ids', '[]'::jsonb)) x where x <> ''
  on conflict (amazon_id) do update set shipment_id = excluded.shipment_id, how = excluded.how, linked_at = now(), linked_by = excluded.linked_by;
  get diagnostics n = row_count;
  update jt.prep_shipments set updated_at = now() where id = sid;
  return n;
end $$;
revoke all on function jt.prep_ship_link(jsonb) from public;

create or replace function public.jt_prep_ship_link(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_ship_link(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_ship_link(jsonb) from public, anon;
grant execute on function public.jt_prep_ship_link(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.prep_shipment_amazon to jt_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.prep_shipment_amazon to fin_reader; end if;
end $$;
