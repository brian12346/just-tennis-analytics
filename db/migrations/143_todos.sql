-- To do list (Brian, Oct 14): the home screen is a to-do list — "people can put things on there so you know what is
-- important today / schedule work". Seller Sage suggests to-dos from what's waiting (orders to approve, invoices with
-- import issues, invoices to receive …); one click turns a suggestion into a to-do, and it ticks itself off when the
-- thing is done.
--
-- jt.todos: a to-do. due_on null = no date (Later). source = the suggestion it came from ('approve:12'); one open
--   to-do per source. link = what it opens ('po:12', 'invoice:7', or a page like 'prep').
-- jt.todo_suggestions(): what's waiting right now, one row per thing (key, kind, title, link, detail, since).
-- jt.todo_autoclose(): open to-dos whose suggestion is gone (done) are marked done by "Seller Sage".
create table if not exists jt.todos (
  id          bigserial primary key,
  title       text not null,
  notes       text not null default '',
  owner       text not null default '',
  due_on      date,
  important   boolean not null default false,
  link        text not null default '',
  source      text,
  done_at     timestamptz,
  done_by     text not null default '',
  created_at  timestamptz not null default now(),
  created_by  text not null default '',
  updated_at  timestamptz not null default now()
);
create unique index if not exists todos_source_open on jt.todos (source) where source is not null and done_at is null;
create index if not exists todos_open on jt.todos (due_on) where done_at is null;

create or replace function jt.todo_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare tid bigint := nullif(p->>'id', '')::bigint;
begin
  if coalesce(btrim(p->>'title'), '') = '' then raise exception 'a to-do needs a title'; end if;
  if tid is null then
    insert into jt.todos (title, notes, owner, due_on, important, link, source, created_by)
    values (btrim(p->>'title'), coalesce(p->>'notes', ''), coalesce(btrim(p->>'owner'), ''), nullif(p->>'due_on', '')::date,
            coalesce((p->>'important')::boolean, false), coalesce(p->>'link', ''), nullif(p->>'source', ''), coalesce(p->>'by', ''))
    on conflict (source) where source is not null and done_at is null do update set updated_at = now()
    returning id into tid;
  else
    update jt.todos set title = btrim(p->>'title'), notes = coalesce(p->>'notes', notes), owner = coalesce(btrim(p->>'owner'), owner),
      due_on = case when p ? 'due_on' then nullif(p->>'due_on', '')::date else due_on end,
      important = coalesce((p->>'important')::boolean, important), link = coalesce(p->>'link', link), updated_at = now()
    where id = tid;
    if not found then raise exception 'to-do % not found', tid; end if;
  end if;
  return tid;
end $$;

create or replace function jt.todo_done(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update jt.todos set done_at = case when coalesce((p->>'done')::boolean, true) then now() end,
    done_by = case when coalesce((p->>'done')::boolean, true) then coalesce(p->>'by', '') else '' end, updated_at = now()
  where id = (p->>'id')::bigint;
  return found;
end $$;

create or replace function jt.todo_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  delete from jt.todos where id = (p->>'id')::bigint;
  return found;
end $$;

-- what's waiting (the same rules as the Orders and Invoices lanes); invoices from the last 120 days
create or replace function jt.todo_suggestions()
returns table (key text, kind text, title text, link text, detail text, since timestamptz)
language sql stable security definer set search_path = '' as $$
  with po as (
    select o.id, o.vendor, o.status, o.approved_at, o.created_at, o.updated_at,
           case when o.po_no ~* '^\s*po' then o.po_no else 'PO ' || coalesce(nullif(o.po_no, ''), '#' || o.id) end as name
    from jt.prep_orders o where o.status = 'draft'),
  iv as (
    select i.id, i.vendor, i.invoice_no, i.created_at, i.received_at, i.qbo_bill_id,
           coalesce(i.order_id, (select o.id from jt.prep_orders o where o.invoice_id = i.id limit 1)) as oid,
           (select count(*) from jt.invoice_lines l where l.invoice_id = i.id and ((l.variant_id is null and l.match_how <> 'skip') or l.match_how like 'guess%')) as issues,
           (select coalesce(sum(l.qty), 0) from jt.invoice_lines l where l.invoice_id = i.id and l.variant_id is not null and l.match_how <> 'skip') as billed
    from jt.invoices i where i.created_at > now() - interval '120 days')
  select 'approve:' || id, 'approve', 'Approve ' || vendor || ' ' || name, 'po:' || id, 'Order ready to approve', created_at from po where approved_at is null
  union all
  select 'submit:' || id, 'submit', 'Give ' || vendor || ' ' || name || ' to the vendor', 'po:' || id, 'Approved — mark it ordered once it''s placed', approved_at from po where approved_at is not null
  union all
  select 'invfix:' || id, 'invfix', 'Fix invoice ' || coalesce(nullif(invoice_no, ''), '#' || id) || ' from ' || vendor, 'invoice:' || id,
         issues || ' line' || case when issues = 1 then '' else 's' end || ' to check', created_at from iv where issues > 0
  union all
  select 'invpo:' || id, 'invpo', 'Build the PO for ' || vendor || ' invoice ' || coalesce(nullif(invoice_no, ''), '#' || id), 'invoice:' || id,
         'No PO yet — Shopify import CSV', created_at from iv where issues = 0 and oid is null
  union all
  select 'receive:' || id, 'receive', 'Receive ' || vendor || ' invoice ' || coalesce(nullif(invoice_no, ''), '#' || id), 'invoice:' || id,
         billed::int || ' unit' || case when billed = 1 then '' else 's' end || ' to receive', created_at from iv where issues = 0 and oid is not null and received_at is null and billed > 0
  union all
  select 'qbo:' || id, 'qbo', 'Enter ' || vendor || ' bill ' || coalesce(nullif(invoice_no, ''), '#' || id) || ' in QuickBooks', 'invoice:' || id,
         'Received, not in QuickBooks', received_at from iv where issues = 0 and oid is not null and received_at is not null and qbo_bill_id is null
$$;

create or replace function jt.todo_autoclose() returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  update jt.todos t set done_at = now(), done_by = 'Seller Sage', updated_at = now()
  where t.done_at is null and t.source is not null and not exists (select 1 from jt.todo_suggestions() s where s.key = t.source);
  get diagnostics n = row_count;
  return n;
end $$;
revoke all on function jt.todo_save(jsonb), jt.todo_done(jsonb), jt.todo_delete(jsonb), jt.todo_suggestions(), jt.todo_autoclose() from public;

-- the web app: who's signed in does it
create or replace function public.jt_todo_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.todo_save(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_todo_done(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.todo_done(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_todo_delete(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.todo_delete(p);
end $$;
create or replace function public.jt_todo_autoclose() returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.todo_autoclose();
end $$;
revoke all on function public.jt_todo_save(jsonb), public.jt_todo_done(jsonb), public.jt_todo_delete(jsonb), public.jt_todo_autoclose() from public, anon;
grant execute on function public.jt_todo_save(jsonb), public.jt_todo_done(jsonb), public.jt_todo_delete(jsonb), public.jt_todo_autoclose() to authenticated;

-- the page reads them through jt_sql (role jt_reader)
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.todos to jt_reader;
    grant execute on function jt.todo_suggestions() to jt_reader;
  end if;
end $$;
