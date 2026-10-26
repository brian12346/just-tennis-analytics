-- Invoice reader: fewer time-outs, and a retry when one happens (Brian, Oct 26: "it timed out. how can we make that not
-- happen and when it does allow for a retry?").
-- Why it timed out: the reader's GitHub Actions run spent 3–4 minutes installing the PDF/OCR tools (apt) before it read
-- anything, past the page's 150 s wait (read 49: queued 16:45:48, read 16:50:17). The workflow now keeps those packages
-- in the Actions cache (seconds to install), the page wakes the reader when the Invoices tab opens or a file is dragged
-- in, and the reader stays up 10 minutes after its last read.
--   jt.invoice_reader_warm()     start the reader if it isn't running (debounced like a queued read)
--   jt.invoice_read_kick(rid)    "Try again" on a read: a failed read is queued again; a read still waiting starts the
--                                reader again. Returns the read (same shape as jt.invoice_read_get).

create or replace function jt.invoice_reader_warm() returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  return jt.dispatch_invoice_read() is not null;
exception when others then return false;               -- never fail the page over the workflow start
end $$;

create or replace function jt.invoice_read_kick(rid bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r jt.invoice_reads;
begin
  select * into r from jt.invoice_reads where id = rid;
  if r.id is null then return null; end if;
  if r.status = 'failed' then                           -- read it again (the trigger starts the reader)
    update jt.invoice_reads set status = 'queued', requested_at = now(), error = null, outcome = null, result = null,
           finished_at = null, attempts = 0 where id = rid;
  elsif r.status = 'queued' then
    perform jt.invoice_reader_warm();
  end if;
  return jt.invoice_read_get(rid);
end $$;

create or replace function public.jt_invoice_reader_warm(p jsonb default '{}'::jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_reader_warm();
end $$;
grant execute on function public.jt_invoice_reader_warm(jsonb) to authenticated;

create or replace function public.jt_invoice_read_kick(rid bigint) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.invoice_read_kick(rid);
end $$;
grant execute on function public.jt_invoice_read_kick(bigint) to authenticated;
