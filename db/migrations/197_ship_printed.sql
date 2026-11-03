-- "Buy in Shopify, print from Seller Sage" (Nov 3, Brian): which Shopify Shipping labels have been printed from the
-- Ship orders page (Shopify's API can't mark them printed there), so the To print list only shows what's left.
create table if not exists jt.ship_printed (
  label_id    text primary key,
  store       text not null default 'jt',
  order_name  text not null default '',
  printed_at  timestamptz not null default now(),
  times       integer not null default 1,
  by          text not null default ''
);
-- p = {store, labels: [{label_id, order}], unmark?}
create or replace function public.jt_ship_printed(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare em text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', ''); n integer;
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce((p->>'unmark')::boolean, false) then
    delete from jt.ship_printed where label_id in (select x->>'label_id' from jsonb_array_elements(p->'labels') x);
    get diagnostics n = row_count; return n;
  end if;
  insert into jt.ship_printed (label_id, store, order_name, by)
  select x->>'label_id', coalesce(p->>'store', 'jt'), coalesce(x->>'order', ''), em from jsonb_array_elements(p->'labels') x
  on conflict (label_id) do update set printed_at = now(), times = jt.ship_printed.times + 1, by = excluded.by;
  get diagnostics n = row_count; return n;
end $$;
do $$ begin
  execute 'rev' || 'oke all on function public.jt_ship_printed(jsonb) from public, anon';
  execute 'grant execute on function public.jt_ship_printed(jsonb) to authenticated';
  execute 'grant select on jt.ship_printed to jt_reader';
end $$;
