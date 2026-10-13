-- Fill history back to Oct 1, 2024 (Brian, Oct 13: Amazon Research's 13–24m, and All sales / Profit for every channel).
-- Amazon payments: jt.fin_backfill_step() (migration 078) takes 'check' from its settings (default true as before);
-- Oct 1 – Dec 31, 2024 had no uploaded Transaction reports to compare with, so they go straight to the Amazon tab's days.
-- When it reaches the end it rebuilds the order-date days for Oct 1, 2024 – Jan 31, 2025 (Q4 refunds posted in January
-- land on their purchase days) — jt.amazon_orderday_save, which also fills jt.amazon_sku_daily.
-- Amazon order reports (action backfill) and Shopify (sync jobs backfill / acenrally --since 2024-10-01) were started
-- by hand the same day.
create or replace function jt.fin_backfill_step() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare st jsonb; r jsonb; nxt date; fin date; rid bigint; d date;
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
    -- the order-date days need the order lines (Amazon's order reports, collected by the hourly sync): wait for them
    -- (most of the range covered), at most a day
    if st ? 'odays_first' and not st ? 'odays_done'
       and (select count(distinct (purchase_at at time zone 'America/Los_Angeles')::date) from jt.amazon_order_lines
            where (purchase_at at time zone 'America/Los_Angeles')::date between (st->>'odays_first')::date and (st->>'end')::date)
           < ((st->>'end')::date - (st->>'odays_first')::date) * 0.9
       and coalesce((st->>'waiting_since')::timestamptz, now()) > now() - interval '1 day' then
      st := st || jsonb_build_object('waiting_since', coalesce(st->>'waiting_since', now()::text), 'waiting_for', 'order reports');
      update jt.settings set value = st, updated_at = now() where key = 'fin_backfill';
      return st;
    end if;
    st := st || jsonb_build_object('done', true, 'finished_at', now());
    if st ? 'odays_first' and not st ? 'odays_done' then   -- then the order-date days, a week at a time
      d := (st->>'odays_first')::date;
      while d <= (st->>'odays_last')::date loop
        perform jt.amazon_orderday_save(d, least(d + 6, (st->>'odays_last')::date));
        d := d + 7;
      end loop;
      st := st || jsonb_build_object('odays_done', now());
    end if;
  else
    rid := jt.amazon_call(jsonb_build_object('action', 'fin_days', 'first', nxt, 'last', least(nxt + 13, fin),
      'check', coalesce((st->>'check')::boolean, true)));
    st := st || jsonb_build_object('req', rid, 'asked_at', now());
  end if;
  update jt.settings set value = st, updated_at = now() where key = 'fin_backfill';
  return st;
end $$;
revoke all on function jt.fin_backfill_step() from public;

update jt.settings set value = jsonb_build_object('next', '2024-10-01', 'end', '2024-12-31', 'done', false, 'check', false,
  'odays_first', '2024-10-01', 'odays_last', '2025-01-31', 'previous', value)
where key = 'fin_backfill' and not value ? 'odays_first';
