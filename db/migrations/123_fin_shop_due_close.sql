-- Finance › Shopify payouts › Waiting for payment (Brian, Oct 11): a part-paid order that was really paid in full — the
-- order amount was wrong and Shopify wouldn't let it be edited, so the customer paid what was actually owed — can be
-- closed out. It leaves the list; nothing is posted (Seller Sage books what was paid, so the gap never reached the books).
-- Each order links to its page in Shopify admin (fin.settings 'shop_post' admin_store).

create table if not exists fin.shop_due_closed (
  store       text not null default 'justtennis',
  order_id    bigint not null,
  outstanding numeric not null default 0,           -- what Shopify still showed as owed when it was closed out
  note        text not null default '',
  closed_by   text not null default '',
  closed_at   timestamptz not null default now(),
  primary key (store, order_id)
);

update fin.settings set value = value || jsonb_build_object('admin_store', 'justtennis-822') where key = 'shop_post' and not value ? 'admin_store';

-- p = {order_id, note?, reopen?: true}
create or replace function public.fin_shop_due_close(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', ''); oid bigint := (p->>'order_id')::bigint;
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce((p->>'reopen')::boolean, false) then
    delete from fin.shop_due_closed where store = 'justtennis' and order_id = oid;
    return found;
  end if;
  insert into fin.shop_due_closed (store, order_id, outstanding, note, closed_by)
  select 'justtennis', oid, coalesce((select outstanding from jt.shopify_order_due where store = 'justtennis' and order_id = oid), 0), coalesce(p->>'note', ''), who
  on conflict (store, order_id) do update set note = excluded.note, closed_by = excluded.closed_by, closed_at = now();
  return true;
end $$;
revoke all on function public.fin_shop_due_close(jsonb) from public;

-- orders still owing money (closed-out ones left off)
create or replace view fin.v_shop_due as
select d.order_id, d.name, d.created_at, (d.created_at at time zone 'America/Los_Angeles')::date as order_day, d.source_name, d.financial_status,
       d.total, d.outstanding, d.total - d.outstanding as paid, d.gateways,
       (now() at time zone 'America/Los_Angeles')::date - (d.created_at at time zone 'America/Los_Angeles')::date as days_old, d.synced_at
from jt.shopify_order_due d
where d.store = 'justtennis' and d.outstanding > 0 and not d.cancelled and not d.test
  and d.financial_status not in ('AUTHORIZED', 'VOIDED', 'REFUNDED')
  and not exists (select 1 from fin.shop_due_closed c where c.store = d.store and c.order_id = d.order_id);

-- the closed-out ones, for the page (reopen)
create or replace view fin.v_shop_due_closed as
select c.order_id, coalesce(d.name, '') as name, (d.created_at at time zone 'America/Los_Angeles')::date as order_day, d.total, c.outstanding, c.note, c.closed_by, c.closed_at
from fin.shop_due_closed c left join jt.shopify_order_due d on d.store = c.store and d.order_id = c.order_id
where c.store = 'justtennis';

grant select on fin.shop_due_closed, fin.v_shop_due, fin.v_shop_due_closed to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_shop_due_close(jsonb) from anon;
    grant execute on function public.fin_shop_due_close(jsonb) to authenticated;
  end if;
end $$;
