-- Load Amazon's payments (Finances API, US + Mexico) for Jan 1, 2025 – Aug 31, 2026, the period that so far only had the
-- uploaded Transaction reports (US only). pg_cron job jt-amazon-fin-backfill runs jt.fin_backfill_step() every 2 minutes:
-- each step reads the previous call's answer and asks the amazon function for the next days (action fin_days, check:
-- true, so the day documents go to amzdays_api and the uploaded amzdays are left alone until compared). Progress is in
-- jt.settings 'fin_backfill'; when it reaches the end it stops by itself.
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
      nxt := coalesce((r->'body'->>'next')::date, (r->'body'->>'last')::date + 1);
      st := st || jsonb_build_object('next', nxt, 'days_done', coalesce((st->>'days_done')::int, 0) + coalesce(jsonb_array_length(r->'body'->'done'), 0));
    else
      st := st || jsonb_build_object('errors', coalesce((st->>'errors')::int, 0) + 1, 'last_error', left(coalesce(r->>'error', r->'body'->>'error', r::text), 300));
    end if;
    st := st || jsonb_build_object('req', null);
  end if;
  if nxt > fin then
    st := st || jsonb_build_object('done', true, 'finished_at', now());
  else
    rid := jt.amazon_call(jsonb_build_object('action', 'fin_days', 'first', nxt, 'last', least(nxt + 13, fin), 'check', true));
    st := st || jsonb_build_object('req', rid, 'asked_at', now());
  end if;
  update jt.settings set value = st, updated_at = now() where key = 'fin_backfill';
  return st;
end $$;
revoke all on function jt.fin_backfill_step() from public;

insert into jt.settings (key, value) values ('fin_backfill', '{"next": "2025-01-01", "end": "2026-08-31", "done": false}')
on conflict (key) do nothing;

do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and not exists (select 1 from cron.job where jobname = 'jt-amazon-fin-backfill') then
    perform cron.schedule('jt-amazon-fin-backfill', '*/2 * * * *', 'select jt.fin_backfill_step()');
  end if;
end $$;
