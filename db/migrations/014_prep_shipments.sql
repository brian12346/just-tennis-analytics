-- Prep center shipments with a simple workflow: open -> started -> shipped.
-- Open and started shipments can be edited (products, quantities, name, destination); stock only leaves the prep center
-- when a shipment is marked shipped (jt.prep_ship does the check and the logging). A shipped shipment is final.

create table if not exists jt.prep_shipments (
  id          bigserial primary key,
  name        text not null default '',         -- Amazon shipment ID or a name
  dest        text not null default 'FBA' check (dest in ('FBA', 'AWD')),
  status      text not null default 'open' check (status in ('open', 'started', 'shipped')),
  note        text not null default '',
  created_at  timestamptz not null default now(),
  created_by  text not null default '',
  started_at  timestamptz,
  shipped_at  timestamptz,
  shipped_by  text not null default '',
  updated_at  timestamptz not null default now()
);
create index if not exists prep_shipments_status_idx on jt.prep_shipments (status, updated_at desc);

create table if not exists jt.prep_shipment_lines (
  shipment_id bigint not null references jt.prep_shipments (id) on delete cascade,
  variant_id  bigint not null,
  amazon_sku  text not null default '',
  qty         integer not null check (qty > 0),
  primary key (shipment_id, variant_id, amazon_sku)
);

alter table jt.prep_moves add column if not exists shipment_id bigint;

-- Create or update an open / started shipment. p = {"id": null|123, "name", "dest", "note", "by",
--   "lines": [{"variant_id", "amazon_sku", "qty"}]}  (lines replace the old ones). Returns the shipment id.
create or replace function jt.prep_shipment_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare sid bigint := nullif(p->>'id', '')::bigint; st text; d text := upper(coalesce(nullif(p->>'dest', ''), 'FBA'));
begin
  if d not in ('FBA', 'AWD') then raise exception 'destination must be FBA or AWD'; end if;
  if sid is null then
    insert into jt.prep_shipments (name, dest, note, created_by)
    values (coalesce(p->>'name', ''), d, coalesce(p->>'note', ''), coalesce(p->>'by', '')) returning id into sid;
  else
    select status into st from jt.prep_shipments where id = sid for update;
    if st is null then raise exception 'shipment % not found', sid; end if;
    if st = 'shipped' then raise exception 'shipment % is already shipped and can''t be changed', sid; end if;
    update jt.prep_shipments set name = coalesce(p->>'name', name), dest = d, note = coalesce(p->>'note', note), updated_at = now() where id = sid;
  end if;
  if p ? 'lines' then
    delete from jt.prep_shipment_lines where shipment_id = sid;
    insert into jt.prep_shipment_lines (shipment_id, variant_id, amazon_sku, qty)
    select sid, (x->>'variant_id')::bigint, coalesce(x->>'amazon_sku', ''), sum((x->>'qty')::integer)
    from jsonb_array_elements(p->'lines') x where coalesce((x->>'qty')::integer, 0) > 0
    group by 2, 3;
  end if;
  return sid;
end $$;
revoke all on function jt.prep_shipment_save(jsonb) from public;

-- Move a shipment along. p = {"id", "status": "open"|"started"|"shipped", "by"}.
-- shipped: takes every line out of the prep center (fails, changing nothing, if a line is short). Shipped is final.
create or replace function jt.prep_shipment_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p->>'id')::bigint; want text := p->>'status'; s record; lines jsonb;
begin
  if want not in ('open', 'started', 'shipped') then raise exception 'unknown status %', want; end if;
  select * into s from jt.prep_shipments where id = sid for update;
  if s.id is null then raise exception 'shipment % not found', sid; end if;
  if s.status = 'shipped' then raise exception 'shipment % is already shipped', sid; end if;
  if want = 'shipped' then
    select jsonb_agg(jsonb_build_object('variant_id', variant_id, 'amazon_sku', amazon_sku, 'qty', qty)) into lines
    from jt.prep_shipment_lines where shipment_id = sid;
    if lines is null then raise exception 'shipment % has no products', sid; end if;
    perform jt.prep_ship(jsonb_build_object('shipment', coalesce(nullif(s.name, ''), 'Shipment ' || sid), 'dest', s.dest,
      'note', s.note, 'by', coalesce(p->>'by', ''), 'lines', lines));
    update jt.prep_moves set shipment_id = sid where kind = 'ship' and shipment_id is null and at = now();
    update jt.prep_shipments set status = 'shipped', shipped_at = now(), shipped_by = coalesce(p->>'by', ''),
      started_at = coalesce(started_at, now()), updated_at = now() where id = sid;
  else
    update jt.prep_shipments set status = want, started_at = case when want = 'started' then coalesce(started_at, now()) else started_at end,
      updated_at = now() where id = sid;
  end if;
  return want;
end $$;
revoke all on function jt.prep_shipment_status(jsonb) from public;

-- Delete an open / started shipment (nothing has left the prep center yet).
create or replace function jt.prep_shipment_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare st text;
begin
  select status into st from jt.prep_shipments where id = (p->>'id')::bigint for update;
  if st is null then return false; end if;
  if st = 'shipped' then raise exception 'a shipped shipment can''t be deleted'; end if;
  delete from jt.prep_shipments where id = (p->>'id')::bigint;
  return true;
end $$;
revoke all on function jt.prep_shipment_delete(jsonb) from public;

-- Web wrappers (app users; "by" = signed-in email)
create or replace function public.jt_prep_shipment_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_shipment_save(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_prep_shipment_status(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_shipment_status(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_prep_shipment_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_shipment_delete(p);
end $$;
revoke all on function public.jt_prep_shipment_save(jsonb), public.jt_prep_shipment_status(jsonb), public.jt_prep_shipment_delete(jsonb) from public, anon;
grant execute on function public.jt_prep_shipment_save(jsonb), public.jt_prep_shipment_status(jsonb), public.jt_prep_shipment_delete(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.prep_shipments, jt.prep_shipment_lines to jt_reader;
  end if;
end $$;
