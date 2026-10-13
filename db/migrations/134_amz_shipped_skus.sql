-- Buying › Amazon Research (Brian, Oct 13): what was sent to Amazon, per SKU, in a date range.
-- One row per shipment + SKU for shipments actually sent (FBA and AWD; not drafts, working or cancelled ones).
-- sent_on: AWD = Amazon's created date (Pacific); FBA = the date in the shipment's name ("FBA STA (09/22/2026 18:56)-POC1"
-- — the FBA v0 API gives no dates), else when we first saw it.
create or replace view jt.v_amz_shipped as
select s.id as shipment_id, s.kind, s.name, s.status, s.destination,
       coalesce(case when s.kind = 'AWD' then (s.created_at at time zone 'America/Los_Angeles')::date end,
                case when s.name ~ '\(\d{1,2}/\d{1,2}/\d{4}' then to_date(substring(s.name from '\((\d{1,2}/\d{1,2}/\d{4})'), 'MM/DD/YYYY') end,
                (s.first_seen at time zone 'America/Los_Angeles')::date) as sent_on,
       i.sku, i.fnsku, i.qty_expected as units_sent, i.qty_received as units_received
from jt.inbound_shipments s
join jt.inbound_shipment_items i on i.shipment_id = s.id
where upper(s.status) not in ('WORKING', 'READY_TO_SHIP', 'CANCELLED', 'CANCELED', 'DELETED', 'ERROR', 'DRAFT', 'VALIDATING', '');

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.v_amz_shipped to jt_reader; end if;
end $$;
