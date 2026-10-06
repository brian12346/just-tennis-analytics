-- 097_invoice_reader.sql  — vendor-template invoice reading, new-vendor learning, invoice history archive.
-- From the Invoice Lab hand-off (digitize-invoice/seller-sage-handoff, Oct 6 2026); applied as 097.
-- Follows the house pattern: jt.* functions (security definer, search_path ''), public.jt_* wrappers gated by jt.is_app_user().
-- Nothing here changes existing tables or functions.

-- ============================================================ 1. vendor templates (data, not code)
-- One row per vendor. `template` is the JSON the reader service runs (identify / variants / line_item / totals ...).
-- `vendor` is the Shopify vendor name exactly as in jt.variants.vendor and jt.invoices.vendor ("Yonex", "K Swiss" ...).
create table if not exists jt.invoice_templates (
  vendor        text primary key,
  slug          text not null unique,                 -- the reader's short id: yonex, kswiss, newbalance ...
  template      jsonb not null,
  qbo_vendor    text,                                 -- vendor name in QuickBooks when it differs (e.g. "Tecnifibre Usa, Inc.")
  active        boolean not null default true,
  version       integer not null default 1,
  notes         text not null default '',
  updated_at    timestamptz not null default now(),
  updated_by    text not null default ''
);

-- ============================================================ 2. read queue (page -> reader service -> page)
-- A read is either of a PDF the page has just been handed (uploaded into jt.invoice_read_files, before any invoice exists)
-- or of an invoice already saved (its PDF in jt.invoice_files). The reader service claims it, reads it, writes `result`.
create table if not exists jt.invoice_reads (
  id           bigint generated always as identity primary key,
  invoice_id   bigint references jt.invoices(id) on delete set null,   -- set when re-reading a saved invoice
  file_name    text not null default '',
  file_parts   integer not null default 0,
  status       text not null default 'queued' check (status in ('uploading','queued','reading','done','failed')),
  requested_at timestamptz not null default now(),
  requested_by text not null default '',
  claimed_at   timestamptz,
  claimed_by   text,
  finished_at  timestamptz,
  attempts     integer not null default 0,
  sha256       text,
  text_method  text,                                  -- pdf_text | ocr
  vendor       text,                                  -- Shopify vendor the template identified (null = unknown vendor)
  outcome      text,                                  -- auto_ok | needs_review | unknown_vendor | unsupported | error
  result       jsonb,                                 -- { invoices: [ {...page parse shape...} ], message }  see HANDOFF.md
  error        text
);
create index if not exists invoice_reads_open on jt.invoice_reads (status, requested_at) where status in ('queued','reading');
create index if not exists invoice_reads_invoice on jt.invoice_reads (invoice_id, id desc) where invoice_id is not null;
-- the PDF of a read that isn't a saved invoice yet: same base64-part format as jt.invoice_files
create table if not exists jt.invoice_read_files (
  read_id  bigint not null references jt.invoice_reads(id) on delete cascade,
  part     integer not null,
  data     text not null,
  primary key (read_id, part)
);

-- OCR text cache: scans are read once (keyed by file hash), re-reads after a template change are instant.
create table if not exists jt.invoice_ocr (
  sha256      text primary key,
  pages       jsonb not null,                         -- ["page 1 text", "page 2 text", ...]
  created_at  timestamptz not null default now()
);

-- ============================================================ 3. invoices to learn from
-- PDFs no vendor template recognised (newest first). Claude builds a template from these (HANDOFF.md, "Learning a vendor").
create or replace view jt.invoices_to_learn as
  select r.id as read_id, r.file_name, r.requested_at, r.requested_by, r.invoice_id, i.vendor as saved_as_vendor,
         i.invoice_no as saved_as_invoice_no, r.text_method
  from jt.invoice_reads r left join jt.invoices i on i.id = r.invoice_id
  where r.outcome = 'unknown_vendor'
    and not exists (select 1 from jt.invoice_reads r2 where r2.sha256 = r.sha256 and r2.id > r.id and r2.outcome <> 'unknown_vendor')
  order by r.id desc;

-- ============================================================ 4. invoice history (archive)
-- Past vendor invoices read by the template engine (2023 -> today). Read-only history: price history, vendor item codes,
-- QuickBooks reconciliation. Kept out of jt.invoices so the PO board and receiving flows are untouched;
-- jt.invoice_from_archive() turns one into a live invoice when you want to work it (e.g. an open bill).
create table if not exists jt.invoice_archive (
  id               bigint generated always as identity primary key,
  vendor           text not null,                     -- Shopify vendor name
  invoice_no       text not null default '',
  doc_type         text not null default 'invoice',   -- invoice | credit_memo | order | receipt
  invoice_date     date,
  due_date         date,
  terms            text not null default '',
  po_no            text not null default '',
  vendor_order_no  text not null default '',
  subtotal         numeric,
  freight          numeric,
  discount         numeric,
  other            numeric,
  other_label      text not null default '',
  tax              numeric,
  total            numeric,
  early_pay        jsonb,                             -- [{pay_by, amount}] when the vendor offers a discount for paying early
  read_status      text not null default 'needs_review', -- auto_ok | needs_review
  issues           jsonb not null default '[]'::jsonb,
  template         text not null default '',          -- e.g. yonex:customer_copy
  text_method      text not null default '',
  file_name        text not null default '',
  file_sha256      text not null default '',
  file_parts       integer not null default 0,
  qbo_status       text,                              -- open_bill | not_open (as of the import date)
  qbo_note         text,
  live_invoice_id  bigint references jt.invoices(id) on delete set null,
  imported_at      timestamptz not null default now(),
  unique (vendor, invoice_no, doc_type)
);
create table if not exists jt.invoice_archive_lines (
  archive_id   bigint not null references jt.invoice_archive(id) on delete cascade,
  line_no      integer not null,
  item_code    text not null default '',
  upc          text not null default '',
  description  text not null default '',
  qty          numeric,
  unit_cost    numeric,
  amount       numeric,
  kind         text not null default 'item' check (kind in ('item','discount','charge')),
  flags        text[] not null default '{}',
  variant_id   bigint,                                -- filled from jt.vendor_items at import / by jt.invoice_archive_rematch()
  primary key (archive_id, line_no)
);
create index if not exists invoice_archive_lines_code on jt.invoice_archive_lines (item_code);
create index if not exists invoice_archive_lines_variant on jt.invoice_archive_lines (variant_id) where variant_id is not null;
-- the PDF, same base64-part format as jt.invoice_files (so the page's PDF viewer code works unchanged)
create table if not exists jt.invoice_archive_files (
  archive_id  bigint not null references jt.invoice_archive(id) on delete cascade,
  part        integer not null,
  data        text not null,
  primary key (archive_id, part)
);

-- ============================================================ 5. functions
-- page: start a read of a PDF it has just been handed -> read id; then send the parts with jt.invoice_read_put
create or replace function jt.invoice_read_start(p jsonb) returns bigint
language plpgsql security definer set search_path to '' as $$
declare rid bigint; n integer := (p->>'parts')::integer;
begin
  if n is null or n < 1 or n > 400 then raise exception 'bad part count %', n; end if;
  insert into jt.invoice_reads (file_name, file_parts, status, requested_by)
  values (coalesce(p->>'name', ''), n, 'uploading', coalesce(p->>'by', '')) returning id into rid;
  return rid;
end $$;

-- page: one part of the PDF (base64, <= 200k characters); the last part queues the read
create or replace function jt.invoice_read_put(p jsonb) returns integer
language plpgsql security definer set search_path to '' as $$
declare rid bigint := (p->>'read_id')::bigint; k integer := (p->>'part')::integer; n integer; got integer;
begin
  select file_parts into n from jt.invoice_reads where id = rid and status = 'uploading';
  if n is null then raise exception 'read % is not waiting for its file', rid; end if;
  if k < 0 or k >= n then raise exception 'bad file part % of %', k, n; end if;
  if length(coalesce(p->>'data', '')) > 200000 then raise exception 'file part too large'; end if;
  insert into jt.invoice_read_files (read_id, part, data) values (rid, k, p->>'data')
  on conflict (read_id, part) do update set data = excluded.data;
  select count(*) into got from jt.invoice_read_files where read_id = rid;
  if got = n then
    update jt.invoice_reads set status = 'queued', requested_at = now() where id = rid;
    perform pg_notify('invoice_reads', rid::text);
  end if;
  return got;
end $$;

-- page: read a saved invoice again (e.g. after a template change)
create or replace function jt.invoice_read_request(p jsonb) returns bigint
language plpgsql security definer set search_path to '' as $$
declare inv bigint := (p->>'invoice_id')::bigint; rid bigint; fn text; n integer;
begin
  select file_name, file_parts into fn, n from jt.invoices where id = inv;
  if coalesce(n, 0) < 1 then raise exception 'invoice % has no saved PDF', inv; end if;
  select id into rid from jt.invoice_reads where invoice_id = inv and status in ('queued','reading') order by id desc limit 1;
  if rid is not null then return rid; end if;
  insert into jt.invoice_reads (invoice_id, file_name, file_parts, requested_by) values (inv, fn, n, coalesce(p->>'by', ''))
  returning id into rid;
  perform pg_notify('invoice_reads', rid::text);
  return rid;
end $$;

-- page: a read's state (poll every ~2 s until status is done or failed)
create or replace function jt.invoice_read_get(rid bigint) returns jsonb
language sql stable security definer set search_path to '' as $$
  select to_jsonb(r) - 'claimed_by' from jt.invoice_reads r where r.id = rid
$$;

-- page: link a read to the invoice it became once saved (keeps the learning queue tidy); optional
create or replace function jt.invoice_read_link(p jsonb) returns void
language sql security definer set search_path to '' as $$
  update jt.invoice_reads set invoice_id = (p->>'invoice_id')::bigint where id = (p->>'read_id')::bigint and invoice_id is null
$$;

-- reader service: claim the next request (stale claims older than 10 minutes are retried, 3 attempts max)
create or replace function jt.invoice_read_claim(worker text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare r jt.invoice_reads;
begin
  update jt.invoice_reads set status = 'failed', error = 'gave up after 3 attempts', finished_at = now()
   where status = 'reading' and claimed_at < now() - interval '10 minutes' and attempts >= 3;
  select * into r from jt.invoice_reads
   where status = 'queued' or (status = 'reading' and claimed_at < now() - interval '10 minutes')
   order by id for update skip locked limit 1;
  if r.id is null then return null; end if;
  update jt.invoice_reads set status = 'reading', claimed_at = now(), claimed_by = worker, attempts = attempts + 1 where id = r.id;
  return jsonb_build_object('id', r.id, 'invoice_id', r.invoice_id, 'file_parts', r.file_parts, 'file_name', r.file_name);
end $$;

-- reader service: the PDF, part by part (base64) — from the read's own upload, else the saved invoice's file
create or replace function jt.invoice_read_file_part(rid bigint, k integer) returns text
language sql stable security definer set search_path to '' as $$
  select coalesce(
    (select data from jt.invoice_read_files where read_id = rid and part = k),
    (select f.data from jt.invoice_reads r join jt.invoice_files f on f.invoice_id = r.invoice_id and f.part = k where r.id = rid))
$$;

-- housekeeping: drop uploaded PDFs of reads older than 30 days, except unrecognised ones (they're the learning samples)
create or replace function jt.invoice_reads_prune() returns integer
language plpgsql security definer set search_path to '' as $$
declare n integer;
begin
  delete from jt.invoice_read_files f using jt.invoice_reads r
  where r.id = f.read_id and r.requested_at < now() - interval '30 days' and coalesce(r.outcome, '') <> 'unknown_vendor';
  get diagnostics n = row_count;
  return n;
end $$;

-- reader service: templates
create or replace function jt.invoice_templates_active() returns jsonb
language sql stable security definer set search_path to '' as $$
  select coalesce(jsonb_object_agg(slug, template || jsonb_build_object('shopify_vendor', vendor, 'qbo_vendor', qbo_vendor)), '{}'::jsonb)
  from jt.invoice_templates where active
$$;

-- reader service: OCR cache
create or replace function jt.invoice_ocr_get(sha text) returns jsonb
language sql stable security definer set search_path to '' as $$ select pages from jt.invoice_ocr where sha256 = sha $$;
create or replace function jt.invoice_ocr_put(sha text, pages jsonb) returns void
language sql security definer set search_path to '' as $$
  insert into jt.invoice_ocr (sha256, pages) values (sha, pages) on conflict (sha256) do nothing
$$;

-- reader service: the result
create or replace function jt.invoice_read_finish(p jsonb) returns void
language plpgsql security definer set search_path to '' as $$
begin
  update jt.invoice_reads set
    status = case when p ? 'error' and coalesce(p->>'error', '') <> '' then 'failed' else 'done' end,
    finished_at = now(), sha256 = p->>'sha256', text_method = p->>'text_method', vendor = p->>'vendor',
    outcome = p->>'outcome', result = p->'result', error = nullif(p->>'error', '')
  where id = (p->>'id')::bigint;
end $$;

-- Claude / admin: add or replace a vendor template (bumps version)
create or replace function jt.invoice_template_put(p jsonb) returns integer
language plpgsql security definer set search_path to '' as $$
declare v integer;
begin
  insert into jt.invoice_templates (vendor, slug, template, qbo_vendor, notes, updated_by)
  values (p->>'vendor', p->>'slug', p->'template', nullif(p->>'qbo_vendor', ''), coalesce(p->>'notes', ''), coalesce(p->>'by', ''))
  on conflict (vendor) do update set slug = excluded.slug, template = excluded.template,
    qbo_vendor = coalesce(excluded.qbo_vendor, jt.invoice_templates.qbo_vendor), notes = excluded.notes,
    version = jt.invoice_templates.version + 1, active = true, updated_at = now(), updated_by = excluded.updated_by
  returning version into v;
  return v;
end $$;

-- history: fill archive lines' variant_id — remembered vendor item codes first, then an exact SKU or UPC match within the vendor
create or replace function jt.invoice_archive_rematch() returns integer
language plpgsql security definer set search_path to '' as $$
declare n integer; m integer; k integer;
begin
  update jt.invoice_archive_lines l set variant_id = vi.variant_id
  from jt.invoice_archive a, jt.vendor_items vi
  where a.id = l.archive_id and vi.vendor = a.vendor and vi.item_code = jt.norm_code(l.item_code)
    and l.kind = 'item' and l.variant_id is distinct from vi.variant_id;
  get diagnostics n = row_count;
  with s as (
    select distinct on (v.vendor, jt.norm_code(v.sku)) v.vendor, jt.norm_code(v.sku) as code, v.variant_id
    from jt.variants v where coalesce(v.sku, '') <> '' and v.removed_at is null
    order by v.vendor, jt.norm_code(v.sku), v.updated_at desc nulls last)
  update jt.invoice_archive_lines l set variant_id = s.variant_id
  from jt.invoice_archive a, s
  where a.id = l.archive_id and l.variant_id is null and l.kind = 'item' and l.item_code <> ''
    and s.vendor = a.vendor and s.code = jt.norm_code(l.item_code);
  get diagnostics m = row_count;
  with b as (
    select distinct on (v.barcode) v.barcode, v.variant_id from jt.variants v
    where coalesce(v.barcode, '') ~ '^[0-9]{11,14}$' and v.removed_at is null order by v.barcode, v.updated_at desc nulls last)
  update jt.invoice_archive_lines l set variant_id = b.variant_id
  from b where l.variant_id is null and l.kind = 'item' and l.upc <> '' and b.barcode = l.upc;
  get diagnostics k = row_count;
  return n + m + k;
end $$;

-- history -> live: make a working invoice (stage 'new', no PO) from an archived one, PDF included
create or replace function jt.invoice_from_archive(p jsonb) returns bigint
language plpgsql security definer set search_path to '' as $$
declare a jt.invoice_archive; inv bigint;
begin
  select * into a from jt.invoice_archive where id = (p->>'archive_id')::bigint;
  if a.id is null then raise exception 'archived invoice not found'; end if;
  if a.live_invoice_id is not null then return a.live_invoice_id; end if;
  select id into inv from jt.invoices where vendor = a.vendor and invoice_no = a.invoice_no limit 1;
  if inv is null then
    inv := jt.save_invoice(jsonb_build_object(
      'vendor', a.vendor, 'invoice_no', a.invoice_no, 'invoice_date', a.invoice_date, 'file_name', a.file_name,
      'subtotal', a.subtotal, 'total', a.total, 'due_date', a.due_date, 'terms', a.terms, 'po_no', a.po_no,
      'notes', 'From invoice history', 'stage', 'new',
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('item_code', l.item_code, 'upc', l.upc, 'description', l.description,
                 'qty', l.qty, 'unit_cost', l.unit_cost, 'amount', l.amount, 'variant_id', l.variant_id,
                 'match_how', case when l.variant_id is not null then 'remembered' else '' end,
                 'account', case when l.kind = 'charge' then 'inbound_shipping' else 'inventory' end) order by l.line_no)
        from jt.invoice_archive_lines l where l.archive_id = a.id), '[]'::jsonb)));
    insert into jt.invoice_files (invoice_id, part, data) select inv, part, data from jt.invoice_archive_files where archive_id = a.id;
    update jt.invoices set file_parts = a.file_parts, file_type = 'application/pdf' where id = inv;
  end if;
  update jt.invoice_archive set live_invoice_id = inv where id = a.id;
  return inv;
end $$;

-- ============================================================ 6. web (public) wrappers, same gate as the rest
create or replace function public.jt_invoice_read_start(p jsonb) returns bigint
language plpgsql security definer set search_path to '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_read_start(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_invoice_read_put(p jsonb) returns integer
language plpgsql security definer set search_path to '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_read_put(p);
end $$;
create or replace function public.jt_invoice_read_request(p jsonb) returns bigint
language plpgsql security definer set search_path to '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_read_request(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
create or replace function public.jt_invoice_read_get(rid bigint) returns jsonb
language plpgsql security definer set search_path to '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_read_get(rid);
end $$;
create or replace function public.jt_invoice_read_link(p jsonb) returns void
language plpgsql security definer set search_path to '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  perform jt.invoice_read_link(p);
end $$;
create or replace function public.jt_invoice_from_archive(p jsonb) returns bigint
language plpgsql security definer set search_path to '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_from_archive(p);
end $$;

-- ============================================================ 7. the reader service's own login (least privilege)
-- Create the role once by hand with a password (not in this file):
--   create role invoice_reader login password '…';   -- then give the service DATABASE_URL with this user
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'invoice_reader') then
    grant usage on schema jt to invoice_reader;
    grant execute on function jt.invoice_read_claim(text), jt.invoice_read_file_part(bigint, integer),
      jt.invoice_templates_active(), jt.invoice_ocr_get(text), jt.invoice_ocr_put(text, jsonb),
      jt.invoice_read_finish(jsonb) to invoice_reader;
    grant execute on function jt.invoice_reads_prune() to invoice_reader;
  end if;
end $$;
-- the jt_reader role (dashboard reads) can see the new tables like the others
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.invoice_templates, jt.invoice_reads, jt.invoice_archive, jt.invoice_archive_lines,
      jt.invoice_archive_files, jt.invoice_read_files, jt.invoices_to_learn to jt_reader;
  end if;
end $$;
revoke all on function jt.invoice_read_claim(text), jt.invoice_read_finish(jsonb), jt.invoice_ocr_put(text, jsonb) from public;

-- house pattern (added when applied): only the gated public wrappers are callable by signed-in users; the jt.* functions
-- by nobody but their owner and the grants above (the reader role)
revoke all on function jt.invoice_read_start(jsonb), jt.invoice_read_put(jsonb), jt.invoice_read_request(jsonb), jt.invoice_read_get(bigint),
  jt.invoice_read_link(jsonb), jt.invoice_read_file_part(bigint, integer), jt.invoice_reads_prune(), jt.invoice_templates_active(),
  jt.invoice_ocr_get(text), jt.invoice_template_put(jsonb), jt.invoice_archive_rematch(), jt.invoice_from_archive(jsonb) from public;
revoke all on function public.jt_invoice_read_start(jsonb), public.jt_invoice_read_put(jsonb), public.jt_invoice_read_request(jsonb),
  public.jt_invoice_read_get(bigint), public.jt_invoice_read_link(jsonb), public.jt_invoice_from_archive(jsonb) from public, anon;
grant execute on function public.jt_invoice_read_start(jsonb), public.jt_invoice_read_put(jsonb), public.jt_invoice_read_request(jsonb),
  public.jt_invoice_read_get(bigint), public.jt_invoice_read_link(jsonb), public.jt_invoice_from_archive(jsonb) to authenticated;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'invoice_reader') then
    grant execute on function jt.invoice_read_file_part(bigint, integer), jt.invoice_templates_active(), jt.invoice_ocr_get(text), jt.invoice_reads_prune() to invoice_reader;
  end if;
end $$;
