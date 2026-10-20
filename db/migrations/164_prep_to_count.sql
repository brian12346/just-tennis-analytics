-- Prep center › Amazon Outgoing: the "Open" lane is now "To Count" (Brian, Oct 20 — real-world feedback: "replace open
-- with 'To Count' where we put things that we want to do but need to be counted. and ensure there is a way to set that
-- state in the item"). An open shipment is to be counted; counting it (Count / Mark counted) moves it to Started.
-- "Back to To count" on a started shipment moves it back and asks for a fresh count: checks.to_count {at, by} records
-- when, so only counts after that time count (the page), and checks.counted is cleared.
create or replace function jt.prep_ship_flow(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare sid bigint := (p->>'id')::bigint; s record; k text; who text := coalesce(p->>'by', '');
begin
  select * into s from jt.prep_shipments where id = sid for update;
  if s.id is null then raise exception 'shipment % not found', sid; end if;
  if p ? 'placement' then
    if coalesce(p->>'placement', '') not in ('', 'optimized', 'fees_ok', 'awd', 'other') then raise exception 'unknown placement %', p->>'placement'; end if;
    -- how it ships decides where it goes: AWD -> dest AWD, an FBA choice -> dest FBA (until it's shipped)
    update jt.prep_shipments set placement = coalesce(p->>'placement', ''),
      dest = case when status = 'shipped' then dest when p->>'placement' = 'awd' then 'AWD'
                  when p->>'placement' in ('optimized', 'fees_ok') then 'FBA' else dest end,
      updated_at = now() where id = sid;
  end if;
  if jsonb_typeof(p->'check') = 'object' then
    for k in select jsonb_object_keys(p->'check') loop
      if k not in ('counted', 'combined', 'sc_created', 'to_count') then raise exception 'unknown check %', k; end if;
      update jt.prep_shipments set checks = case when coalesce((p->'check'->>k)::boolean, false)
          then checks || jsonb_build_object(k, jsonb_build_object('at', now(), 'by', who)) else checks - k end, updated_at = now()
      where id = sid;
    end loop;
  end if;
  if p ? 'close' then
    if coalesce((p->>'close')::boolean, false) then
      if s.status <> 'shipped' then raise exception 'mark the shipment shipped before closing it'; end if;
      update jt.prep_shipments set closed_at = now(), closed_by = who, updated_at = now() where id = sid;
    else
      update jt.prep_shipments set closed_at = null, closed_by = '', updated_at = now() where id = sid;
    end if;
  end if;
  if p ? 'exception' then
    update jt.prep_shipments set exception = coalesce(p->>'exception', ''),
      exception_at = case when coalesce(p->>'exception', '') = '' then null else now() end,
      exception_by = case when coalesce(p->>'exception', '') = '' then '' else who end, updated_at = now()
    where id = sid;
  end if;
  return (select to_jsonb(x) - 'note' from jt.prep_shipments x where id = sid);
end $$;
revoke all on function jt.prep_ship_flow(jsonb) from public;
