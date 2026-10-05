-- Payments backfill fixes: an answer without next/last no longer loses the step's place (it set 'next' to null after
-- the database restarts on Oct 5), a missing next day is reported instead of calling Amazon with no dates, and each step
-- asks for 7 days instead of 14 so the busy Q4 days are smaller saves.
create or replace function jt.fin_backfill_step() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st jsonb; r jsonb; nxt date; fin date; rid bigint;
begin
  select value into st from jt.settings where key = 'fin_backfill';
  if st is null or coalesce((st->>'done')::boolean, false) then return st; end if;
  nxt := (st->>'next')::date; fin := (st->>'end')::date;
  if st ? 'req' and st->>'req' is not null then
    r := jt.qbo_result((st->>'req')::bigint);
    if r is null then
      if (st->>'asked_at')::timestamptz > now() - interval '6 minutes' then return st; end if;   -- still running
      st := st || jsonb_build_object('errors', coalesce((st->>'errors')::int, 0) + 1, 'last_error', 'no answer');
    elsif coalesce((r->'body'->>'ok')::boolean, false) then
      nxt := coalesce((r->'body'->>'next')::date, (r->'body'->>'last')::date + 1, nxt);   -- keep our place if the answer has neither
      st := st || jsonb_build_object('next', nxt, 'days_done', coalesce((st->>'days_done')::int, 0) + coalesce(jsonb_array_length(r->'body'->'done'), 0));
    else
      st := st || jsonb_build_object('errors', coalesce((st->>'errors')::int, 0) + 1, 'last_error', left(coalesce(r->>'error', r->'body'->>'error', r::text), 300));
    end if;
    st := st || jsonb_build_object('req', null);
  end if;
  if nxt is null then
    st := st || jsonb_build_object('errors', coalesce((st->>'errors')::int, 0) + 1, 'last_error', 'no next day');
  elsif nxt > fin then
    st := st || jsonb_build_object('done', true, 'finished_at', now());
  else
    rid := jt.amazon_call(jsonb_build_object('action', 'fin_days', 'first', nxt, 'last', least(nxt + 6, fin), 'check', true));
    st := st || jsonb_build_object('req', rid, 'asked_at', now());
  end if;
  update jt.settings set value = st, updated_at = now() where key = 'fin_backfill';
  return st;
end $$;
revoke all on function jt.fin_backfill_step() from public;

-- pick up where it was (Oct 3, 2025) if 'next' was lost
update jt.settings set value = value || jsonb_build_object('next', (date '2025-01-01' + (value->>'days_done')::int)::text, 'req', null)
where key = 'fin_backfill' and value->>'next' is null and not coalesce((value->>'done')::boolean, false);
