-- Amazon Research needs the SKUs on every FBA shipment. Asking Amazon for shipments since Jan 2025 (Oct 13) brought in
-- ~5,600 older FBA shipments without their SKU quantities. pg_cron job jt-amazon-inbound-backfill runs
-- jt.inbound_backfill_step() every 2 minutes: it reads the previous call's answer and asks the amazon function's
-- inbound_shipments action (FBA, backfill_items) for the next 10 days of last-updated dates, repeating a window until
-- its items are all read (at most 5 tries). Progress is in jt.settings 'inbound_backfill'; at the end it stops by itself.
create or replace function jt.inbound_backfill_step() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st jsonb; r jsonb; nxt date; fin date; rid bigint; tries int;
begin
  select value into st from jt.settings where key = 'inbound_backfill';
  if st is null or coalesce((st->>'done')::boolean, false) then return st; end if;
  nxt := (st->>'next')::date; fin := (st->>'end')::date; tries := coalesce((st->>'tries')::int, 0);
  if st ? 'req' and st->>'req' is not null then
    r := jt.qbo_result((st->>'req')::bigint);
    if r is null then
      if (st->>'asked_at')::timestamptz > now() - interval '6 minutes' then return st; end if;   -- still running
      st := st || jsonb_build_object('errors', coalesce((st->>'errors')::int, 0) + 1, 'last_error', 'no answer');
      tries := tries + 1;
    elsif coalesce((r->'body'->>'ok')::boolean, false) and coalesce(r->'body'->'fba'->>'error', '') = ''
          and coalesce((r->'body'->'fba'->>'done')::boolean, false) then
      st := st || jsonb_build_object('items_read', coalesce((st->>'items_read')::int, 0) + coalesce((r->'body'->'fba'->>'items')::int, 0));
      nxt := nxt + 10; tries := 0;                                  -- this window is done
    else
      st := st || jsonb_build_object('items_read', coalesce((st->>'items_read')::int, 0) + coalesce((r->'body'->'fba'->>'items')::int, 0),
        'last_error', left(coalesce(nullif(r->'body'->'fba'->>'error', ''), r->>'error', r->'body'->>'error', ''), 300));
      tries := tries + 1;
    end if;
    if tries >= 5 then nxt := nxt + 10; tries := 0; st := st || jsonb_build_object('skipped', coalesce(st->'skipped', '[]'::jsonb) || to_jsonb(nxt - 10)); end if;
    st := st || jsonb_build_object('req', null, 'next', nxt, 'tries', tries);
  end if;
  if nxt > fin then
    st := st || jsonb_build_object('done', true, 'finished_at', now());
  else
    rid := jt.amazon_call(jsonb_build_object('action', 'inbound_shipments', 'kinds', jsonb_build_array('fba'), 'backfill_items', true,
      'since', (nxt::timestamp at time zone 'UTC'), 'until', (least(nxt + 10, fin + 1)::timestamp at time zone 'UTC')));
    st := st || jsonb_build_object('req', rid, 'asked_at', now());
  end if;
  update jt.settings set value = st, updated_at = now() where key = 'inbound_backfill';
  return st;
end $$;
revoke all on function jt.inbound_backfill_step() from public;

insert into jt.settings (key, value) values ('inbound_backfill', '{"next": "2024-07-01", "end": "2026-10-13", "done": false}')
on conflict (key) do nothing;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and not exists (select 1 from cron.job where jobname = 'jt-amazon-inbound-backfill') then
    perform cron.schedule('jt-amazon-inbound-backfill', '*/2 * * * *', 'select jt.inbound_backfill_step()');
  end if;
end $$;
