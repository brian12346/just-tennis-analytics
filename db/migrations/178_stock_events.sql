-- Receive log / inventory history (Brian, Oct 29: "we really need a receive log under orders. where we capture what was
-- committed and written to shopify and/or prep center. grouped by each time a receive button was pressed and then able
-- to be expanded to see what was written where and we also need to handle roll backs. please also include system
-- generated updates when you fix things as that does affect inventory ... an inventory update log within a given
-- product").
--
-- jt.stock_events: one row per press of a button (one database transaction) per PO; every stock move written in that
-- transaction (jt.prep_moves, jt.shopify_stock_moves) carries its event_id, and every change to a PO line's received
-- count is kept in jt.stock_event_lines. Triggers do the grouping, so receiving, un-receiving, counts, shipments to
-- Amazon, moves and fixes run from SQL are all logged without changing those functions. A fix run by hand sets
-- jt.event_by / jt.event_kind / jt.event_note first (set_config(..., true)) so it shows who and why.
create table if not exists jt.stock_events (
  id bigserial primary key,
  tx bigint not null default 0,
  at timestamptz not null default now(),
  by_user text not null default '',
  order_id bigint,
  invoice_id bigint,
  kind text not null default '',
  note text not null default '',
  rollback_of bigint,
  rolled_back_by bigint,
  rolled_back_at timestamptz,
  backfilled boolean not null default false
);
create index if not exists stock_events_tx on jt.stock_events (tx);
create index if not exists stock_events_order on jt.stock_events (order_id);
create index if not exists stock_events_at on jt.stock_events (at desc);
create table if not exists jt.stock_event_lines (
  id bigserial primary key,
  event_id bigint not null references jt.stock_events (id),
  order_id bigint,
  variant_id bigint,
  amazon_sku text not null default '',
  dest text not null default '',
  qty_change integer not null
);
create index if not exists stock_event_lines_event on jt.stock_event_lines (event_id);
create index if not exists stock_event_lines_variant on jt.stock_event_lines (variant_id);
alter table jt.shopify_stock_moves add column if not exists event_id bigint;
alter table jt.prep_moves add column if not exists event_id bigint;
create index if not exists shopify_stock_moves_event on jt.shopify_stock_moves (event_id);
create index if not exists prep_moves_event on jt.prep_moves (event_id);
create index if not exists shopify_stock_moves_variant on jt.shopify_stock_moves (variant_id);
create index if not exists prep_moves_variant on jt.prep_moves (variant_id);
alter table jt.stock_events enable row level security;
alter table jt.stock_event_lines enable row level security;

-- the event for this transaction and PO (made the first time something is written)
create or replace function jt.stock_event_for(ord bigint, who text, k text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare e bigint; t bigint := txid_current(); inv text := nullif(current_setting('jt.receiving_invoice', true), '');
  jwt text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '');
begin
  select id into e from jt.stock_events where tx = t and order_id is not distinct from ord order by id limit 1;
  if e is null then
    insert into jt.stock_events (tx, by_user, order_id, invoice_id, kind, note, rollback_of)
    values (t, coalesce(nullif(current_setting('jt.event_by', true), ''), nullif(who, ''), jwt, ''), ord,
      case when inv ~ '^\d+$' then inv::bigint end,
      coalesce(nullif(current_setting('jt.event_kind', true), ''), k, ''),
      coalesce(current_setting('jt.event_note', true), ''),
      nullif(current_setting('jt.event_of', true), '')::bigint)
    returning id into e;
  elsif coalesce(who, '') <> '' then
    update jt.stock_events set by_user = who where id = e and by_user = '';
  end if;
  return e;
end $$;

create or replace function jt.trg_stock_event_line() returns trigger
language plpgsql security definer set search_path = '' as $$
declare d integer := new.qty_received - coalesce(case when tg_op = 'UPDATE' then old.qty_received end, 0); e bigint;
begin
  if d <> 0 then
    e := jt.stock_event_for(new.order_id, '', case when d > 0 then 'receive' else 'unreceive' end);
    insert into jt.stock_event_lines (event_id, order_id, variant_id, amazon_sku, dest, qty_change)
    values (e, new.order_id, new.variant_id, new.amazon_sku, new.dest, d);
  end if;
  return null;
end $$;
create or replace function jt.trg_prep_move_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event_id is null then new.event_id := jt.stock_event_for(new.order_id, new.by_user, new.kind); end if;
  return new;
end $$;
create or replace function jt.trg_shopify_move_event() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.event_id is null then new.event_id := jt.stock_event_for(new.order_id, new.created_by, new.kind); end if;
  return new;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'stock_event_line') then
    create trigger stock_event_line after insert or update of qty_received on jt.prep_order_lines for each row execute function jt.trg_stock_event_line();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'prep_move_event') then
    create trigger prep_move_event before insert on jt.prep_moves for each row execute function jt.trg_prep_move_event();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'shopify_move_event') then
    create trigger shopify_move_event before insert on jt.shopify_stock_moves for each row execute function jt.trg_shopify_move_event();
  end if;
end $$;

-- Roll back one press: what it received comes back off (prep center and Shopify stock, invoice receipts), what it
-- un-received is received again. All or nothing (refused if, say, the prep center units already shipped to Amazon).
-- p = {id, by}
create or replace function jt.stock_event_rollback(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare e record; l record; ne bigint; n integer := 0; who text := coalesce(p->>'by', '');
begin
  select * into e from jt.stock_events where id = (p->>'id')::bigint for update;
  if e.id is null then raise exception 'log entry % not found', p->>'id'; end if;
  if e.rolled_back_by is not null then raise exception 'this was already rolled back'; end if;
  if not exists (select 1 from jt.stock_event_lines where event_id = e.id) then raise exception 'only receiving on a PO can be rolled back here'; end if;
  perform set_config('jt.event_kind', 'rollback', true);
  perform set_config('jt.event_of', e.id::text, true);
  perform set_config('jt.event_by', who, true);
  perform set_config('jt.event_note', 'rolled back #' || e.id, true);
  for l in select order_id, variant_id, amazon_sku, dest, sum(qty_change)::integer as q from jt.stock_event_lines where event_id = e.id
           group by 1, 2, 3, 4 having sum(qty_change) <> 0 loop
    if l.q > 0 then
      perform jt.prep_order_unreceive_line(jsonb_build_object('id', l.order_id, 'variant_id', l.variant_id, 'amazon_sku', l.amazon_sku,
        'dest', l.dest, 'qty', l.q, 'by', who, 'note', 'rolled back #' || e.id));
    else
      perform jt.prep_order_receive(jsonb_build_object('id', l.order_id, 'by', who, 'note', 'rolled back #' || e.id,
        'lines', jsonb_build_array(jsonb_build_object('variant_id', l.variant_id, 'amazon_sku', l.amazon_sku, 'dest', l.dest, 'qty', -l.q))));
    end if;
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'nothing to roll back'; end if;
  select id into ne from jt.stock_events where tx = txid_current() and rollback_of = e.id order by id limit 1;
  update jt.stock_events set rolled_back_by = ne, rolled_back_at = now() where id = e.id;
  perform set_config('jt.event_kind', '', true); perform set_config('jt.event_of', '', true);
  perform set_config('jt.event_by', '', true); perform set_config('jt.event_note', '', true);
  return ne;
end $$;
create or replace function public.jt_stock_event_rollback(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.stock_event_rollback(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.stock_event_for(bigint, text, text) from public';
  execute 'rev' || 'oke all on function jt.stock_event_rollback(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_stock_event_rollback(jsonb) from public, anon';
  execute 'grant execute on function public.jt_stock_event_rollback(jsonb) to authenticated';
end $$;

-- Backfill: moves before this are grouped by PO, person, kind and minute into events (marked backfilled); their PO lines
-- come from the receive / un-receive moves (lines with no stock move, e.g. Not for resale, weren't kept before).
do $$ declare r record; e bigint; begin
  if exists (select 1 from jt.stock_events where backfilled) then return; end if;
  for r in
    select order_id, who, k, m, min(at) as at, array_agg(src || ':' || id) as ids from (
      select 'p' as src, id, order_id, coalesce(by_user, '') as who,
        case when kind in ('receive', 'unreceive') then kind else kind end as k, date_trunc('minute', at) as m, at from jt.prep_moves where event_id is null
      union all
      select 's', id, order_id, coalesce(created_by, ''), kind, date_trunc('minute', created_at), created_at from jt.shopify_stock_moves where event_id is null
    ) x group by order_id, who, k, m order by min(at)
  loop
    insert into jt.stock_events (tx, at, by_user, order_id, kind, backfilled) values (0, r.at, r.who, r.order_id, r.k, true) returning id into e;
    update jt.prep_moves set event_id = e where id in (select substr(i, 3)::bigint from unnest(r.ids) i where i like 'p:%');
    update jt.shopify_stock_moves set event_id = e where id in (select substr(i, 3)::bigint from unnest(r.ids) i where i like 's:%');
    if r.k in ('receive', 'unreceive') and r.order_id is not null then
      insert into jt.stock_event_lines (event_id, order_id, variant_id, amazon_sku, dest, qty_change)
      select e, r.order_id, variant_id, amazon_sku, 'prep', qty_change from jt.prep_moves where event_id = e
      union all
      select e, r.order_id, variant_id, coalesce(amazon_sku, ''), 'shopify', delta from jt.shopify_stock_moves where event_id = e;
    end if;
  end loop;
end $$;
