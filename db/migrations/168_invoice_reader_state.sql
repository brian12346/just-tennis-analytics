-- Invoice reader: the page knows whether the reader is still loading (Brian, Oct 26: "make sure all the reader info is
-- in place before the try again button is avail ... say something like system is still loading").
-- jt.invoice_read_get(rid) now also returns `reader`: whether a reader run is up (heartbeat) or was started for this
-- read and is still loading (dispatched in the last 8 minutes, GitHub accepted it). While it's loading the page keeps
-- waiting and says so; "Try again" only shows once the reader has failed, or stopped loading without reading.
create or replace function jt.invoice_read_get(rid bigint) returns jsonb
language sql stable security definer set search_path = '' as $$
  with s as (select (value->>'seen_at')::timestamptz as seen from jt.settings where key = 'invoice_reader'),
  d as (select x.requested_at, x.request_id from jt.sync_dispatches x where x.job = 'invoice-read' order by x.id desc limit 1)
  select to_jsonb(r) - 'claimed_by' || jsonb_build_object('reader', jsonb_build_object(
           'up', coalesce((select seen > now() - interval '30 seconds' from s), false),
           'dispatched_at', (select requested_at from d),
           'loading', coalesce((select d.requested_at > now() - interval '8 minutes'
                                   and coalesce((select h.status_code between 200 and 299 or h.status_code is null
                                                 from net._http_response h where h.id = d.request_id), true) from d), false),
           'now', now()))
  from jt.invoice_reads r where r.id = rid
$$;
