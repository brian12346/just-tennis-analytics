-- A draft order is either still being put together (Draft) or ready to approve (Brian, Oct 29: "we should have a draft
-- state for an order and then have a button within the order to say 'ready to approve'. both states in the leftmost
-- swimlane"). ready_at is set by the order's Ready to approve button and cleared by Back to draft. Drafts that were in
-- Ready to approve before this keep that state.
alter table jt.prep_orders add column if not exists ready_at timestamptz;
alter table jt.prep_orders add column if not exists ready_by text not null default '';
update jt.prep_orders set ready_at = coalesce(updated_at, created_at) where status = 'draft' and approved_at is null and ready_at is null;

-- p = {id, on: true | false, by}
create or replace function jt.po_ready(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare on_ boolean := coalesce((p->>'on')::boolean, true);
begin
  update jt.prep_orders set ready_at = case when on_ then now() else null end, ready_by = case when on_ then coalesce(p->>'by', '') else '' end, updated_at = now()
  where id = (p->>'id')::bigint and status = 'draft';
  if not found then raise exception 'draft order % not found', p->>'id'; end if;
  return true;
end $$;

create or replace function public.jt_po_ready(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_ready(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.po_ready(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_po_ready(jsonb) from public, anon';
  execute 'grant execute on function public.jt_po_ready(jsonb) to authenticated';
end $$;
