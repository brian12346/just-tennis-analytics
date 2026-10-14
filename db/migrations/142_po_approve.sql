-- Orders lanes (Brian, Oct 14): Ready to approve → Awaiting submission → Ordered → Invoiced → Received → Recorded.
-- A draft order is approved with a button (who and when are kept), then waits to be given to the vendor; "Mark ordered"
-- moves it on by hand. Approval only applies to drafts; undoing it puts the draft back to Ready to approve. An order
-- moved back to draft keeps its approval.
alter table jt.prep_orders add column if not exists approved_at timestamptz;
alter table jt.prep_orders add column if not exists approved_by text not null default '';

create or replace function jt.po_approve(p jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; yes boolean := coalesce((p->>'approve')::boolean, true); st text; at timestamptz;
begin
  select status into st from jt.prep_orders where id = ord for update;
  if st is null then raise exception 'order % not found', ord; end if;
  if st <> 'draft' then raise exception 'only a draft order is approved (this one is %)', st; end if;
  update jt.prep_orders set approved_at = case when yes then now() end, approved_by = case when yes then coalesce(p->>'by', '') else '' end,
    updated_at = now() where id = ord returning approved_at into at;
  return at;
end $$;
revoke all on function jt.po_approve(jsonb) from public;

create or replace function public.jt_po_approve(p jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_approve(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_po_approve(jsonb) from public, anon;
grant execute on function public.jt_po_approve(jsonb) to authenticated;
