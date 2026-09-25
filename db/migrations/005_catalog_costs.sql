-- Product catalog in the dashboard: inventory on hand, and cost edits that are written back to Shopify.

alter table jt.variants add column if not exists inventory_item_id bigint;
alter table jt.variants add column if not exists inventory_qty integer;      -- on hand, all locations (nightly)
alter table jt.variants add column if not exists tracked boolean;           -- Shopify tracks inventory for it

-- Cost changes typed in the dashboard, applied to Shopify by the sync (job cost-updates, also every hourly run).
create table if not exists jt.cost_updates (
  id                bigserial primary key,
  variant_id        bigint not null,
  inventory_item_id bigint,
  old_cost          numeric(12,2),
  new_cost          numeric(12,2) not null check (new_cost >= 0),
  requested_at      timestamptz not null default now(),
  status            text not null default 'pending' check (status in ('pending', 'done', 'failed', 'replaced')),
  applied_at        timestamptz,
  error             text not null default ''
);
create index if not exists cost_updates_pending_idx on jt.cost_updates (status, variant_id);

-- Queue new costs: p = [{"variant_id": 123, "cost": 12.5}, ...]. A newer request for the same variant replaces an
-- older pending one. Starts the sync right away when the Supabase scheduler is installed (db/supabase).
create or replace function jt.queue_cost_updates(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update jt.cost_updates u set status = 'replaced'
  where u.status = 'pending' and u.variant_id in (select (x->>'variant_id')::bigint from jsonb_array_elements(p) x);
  insert into jt.cost_updates (variant_id, inventory_item_id, old_cost, new_cost)
  select distinct on (v.variant_id) v.variant_id, v.inventory_item_id, v.unit_cost, round((x.e->>'cost')::numeric, 2)
  from jsonb_array_elements(p) with ordinality x(e, n)
  join jt.variants v on v.variant_id = (x.e->>'variant_id')::bigint
  order by v.variant_id, x.n desc;                                   -- same variant twice: the last one wins
  get diagnostics n = row_count;
  if n > 0 and to_regprocedure('jt.dispatch_sync(text)') is not null then
    perform jt.dispatch_sync('cost-updates');
  end if;
  return n;
end $$;
revoke all on function jt.queue_cost_updates(jsonb) from public;

-- Web dashboard entry point (same access rule as the other jt_* functions).
create or replace function public.jt_queue_cost_updates(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.queue_cost_updates(p);
end $$;
revoke all on function public.jt_queue_cost_updates(jsonb) from public, anon;
grant execute on function public.jt_queue_cost_updates(jsonb) to authenticated;
