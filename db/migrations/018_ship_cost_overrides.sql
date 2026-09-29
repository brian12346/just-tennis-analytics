-- Shipping cost entered by hand for a Shopify order with no ShipStation label: a label bought elsewhere, or an order
-- that shipped in the same box as another order (combined_with = that order's name, cost usually 0 because the label
-- is already counted on the other order). The Shopify tab uses it when the order has no label of its own.

create table if not exists jt.ship_cost_overrides (
  order_id       bigint primary key,
  cost           numeric(10,2) not null check (cost >= 0),
  combined_with  text not null default '',
  note           text not null default '',
  by_user        text not null default '',
  updated_at     timestamptz not null default now()
);

-- p = {order_id, cost, combined_with, note, by}
create or replace function jt.save_ship_cost(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not exists (select 1 from jt.shopify_orders o where o.order_id = (p->>'order_id')::bigint) then raise exception 'unknown order %', p->>'order_id'; end if;
  insert into jt.ship_cost_overrides (order_id, cost, combined_with, note, by_user)
  values ((p->>'order_id')::bigint, coalesce(nullif(p->>'cost', '')::numeric, 0), coalesce(p->>'combined_with', ''), coalesce(p->>'note', ''), coalesce(p->>'by', ''))
  on conflict (order_id) do update set cost = excluded.cost, combined_with = excluded.combined_with, note = excluded.note, by_user = excluded.by_user, updated_at = now();
  return true;
end $$;
revoke all on function jt.save_ship_cost(jsonb) from public;

create or replace function jt.delete_ship_cost(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from jt.ship_cost_overrides where order_id = (p->>'order_id')::bigint;
  return found;
end $$;
revoke all on function jt.delete_ship_cost(jsonb) from public;

create or replace function public.jt_save_ship_cost(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.save_ship_cost(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_delete_ship_cost(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.delete_ship_cost(p);
end $$;
revoke all on function public.jt_save_ship_cost(jsonb), public.jt_delete_ship_cost(jsonb) from public, anon;
grant execute on function public.jt_save_ship_cost(jsonb), public.jt_delete_ship_cost(jsonb) to authenticated;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.ship_cost_overrides to jt_reader; end if;
end $$;
