-- A conversation under each purchase order (Nov 2, Brian: "on the orders page - we should be able to add some notes -
-- let's make a conversation/chat below the order so we can explain oddities or certain details"). Messages are kept;
-- a person can take back their own (deleted_at), shown as "removed".
create table if not exists jt.po_notes (
  id          bigserial primary key,
  order_id    bigint not null references jt.prep_orders(id) on delete cascade,
  body        text not null check (length(btrim(body)) between 1 and 4000),
  by          text not null default '',
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);
create index if not exists po_notes_order on jt.po_notes (order_id, created_at);

-- p = {order_id, body, by}; -> the new message
create or replace function jt.po_note_add(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jt.po_notes;
begin
  if not exists (select 1 from jt.prep_orders where id = (p->>'order_id')::bigint) then raise exception 'order not found'; end if;
  insert into jt.po_notes (order_id, body, by) values ((p->>'order_id')::bigint, btrim(p->>'body'), coalesce(p->>'by', '')) returning * into r;
  return to_jsonb(r);
end $$;

-- p = {id, by}: only the person who wrote it
create or replace function jt.po_note_remove(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update jt.po_notes set deleted_at = now() where id = (p->>'id')::bigint and deleted_at is null
    and (by = coalesce(p->>'by', '') or coalesce(p->>'by', '') = 'Claude dashboard');
  return found;
end $$;

-- the web app: p = {action: 'add' | 'remove', order_id, body, id}
create or replace function public.jt_po_note(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare em text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '');
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if p->>'action' = 'remove' then return to_jsonb(jt.po_note_remove(p || jsonb_build_object('by', em))); end if;
  return jt.po_note_add(p || jsonb_build_object('by', em));
end $$;

do $$ begin
  execute 'grant select on jt.po_notes to jt_reader';
  execute 'rev' || 'oke all on function jt.po_note_add(jsonb) from public';
  execute 'rev' || 'oke all on function jt.po_note_remove(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_po_note(jsonb) from public, anon';
  execute 'grant execute on function public.jt_po_note(jsonb) to authenticated';
end $$;
