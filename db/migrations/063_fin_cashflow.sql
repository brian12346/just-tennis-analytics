-- Finance dashboard, Cash flow page: a rolling 4-month weekly forecast of money in (Amazon and Shopify payouts,
-- other receipts) and out (QuickBooks bills by due date, other payments), with a running balance from a starting
-- bank balance.
--
-- Estimates are worked out on the page from history (Amazon payouts in jt.amazon_fin_lines, Shopify payouts in
-- fin.shopify_payouts or Shopify sales) and roll forward on their own. fin.forecast holds only what a person typed:
-- an amount for one expected payout (replaces the estimate), or an extra line in or out.

create table if not exists fin.forecast (
  id          bigserial primary key,
  kind        text not null check (kind in ('payout', 'other_in', 'other_out')),
  stream      text not null default '',      -- payouts: which payout stream (e.g. 'amazon:ATVPDKIKX0DER:4', 'shopify')
  expected_on date not null,
  amount      numeric not null,
  note        text not null default '',
  active      boolean not null default true,     -- false: cleared / taken off (kept for the record)
  updated_by  text not null default '',
  updated_at  timestamptz not null default now()
);
-- one typed amount per payout stream and date
create unique index if not exists forecast_payout on fin.forecast (stream, expected_on) where kind = 'payout';

create table if not exists fin.settings (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into fin.settings (key, value) values
  ('cash', jsonb_build_object('balance', null, 'as_of', null)),
  ('shopify', jsonb_build_object('weekday', 1, 'pct_of_sales', 97))   -- Monday; payout ≈ 97% of sales until real payouts are in
on conflict (key) do nothing;

-- Shopify Payments payouts (sync job shopify-payouts; needs the read_shopify_payments_payouts scope)
create table if not exists fin.shopify_payouts (
  id         text primary key,
  issued_at  timestamptz,
  status     text not null default '',
  amount     numeric not null default 0,
  currency   text not null default 'USD',
  synced_at  timestamptz not null default now()
);

-- p = {op: 'set', stream, expected_on, amount, note} (a payout amount; amount null clears it -> back to the estimate)
--   | {op: 'add', kind: 'other_in' | 'other_out', expected_on, amount, note}
--   | {op: 'edit', id, expected_on?, amount?, note?} | {op: 'remove', id}
create or replace function fin.forecast_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r fin.forecast; who text := coalesce(nullif(p->>'by', ''), 'finance');
begin
  if p->>'op' = 'set' then
    if p->>'amount' is null then
      update fin.forecast set active = false, updated_by = who, updated_at = now()
      where kind = 'payout' and stream = p->>'stream' and expected_on = (p->>'expected_on')::date;
      return jsonb_build_object('ok', true, 'cleared', true);
    end if;
    insert into fin.forecast (kind, stream, expected_on, amount, note, updated_by)
    values ('payout', p->>'stream', (p->>'expected_on')::date, (p->>'amount')::numeric, coalesce(p->>'note', ''), who)
    on conflict (stream, expected_on) where kind = 'payout'
    do update set amount = excluded.amount, note = excluded.note, active = true, updated_by = excluded.updated_by, updated_at = now()
    returning * into r;
  elsif p->>'op' = 'add' then
    if p->>'kind' not in ('other_in', 'other_out') then raise exception 'kind must be other_in or other_out'; end if;
    insert into fin.forecast (kind, expected_on, amount, note, updated_by)
    values (p->>'kind', (p->>'expected_on')::date, abs((p->>'amount')::numeric), coalesce(p->>'note', ''), who)
    returning * into r;
  elsif p->>'op' = 'edit' then
    update fin.forecast set expected_on = coalesce((p->>'expected_on')::date, expected_on),
      amount = coalesce(abs((p->>'amount')::numeric), amount), note = coalesce(p->>'note', note), updated_by = who, updated_at = now()
    where id = (p->>'id')::bigint and kind in ('other_in', 'other_out') returning * into r;
  elsif p->>'op' = 'remove' then
    update fin.forecast set active = false, updated_by = who, updated_at = now()
    where id = (p->>'id')::bigint and kind in ('other_in', 'other_out') returning * into r;
  else
    raise exception 'unknown op %', p->>'op';
  end if;
  return to_jsonb(r);
end $$;

-- p = {key: 'cash' | 'shopify', value: {...}} merged into the setting
create or replace function fin.settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p->>'key' not in ('cash', 'shopify') then raise exception 'unknown setting %', p->>'key'; end if;
  insert into fin.settings (key, value) values (p->>'key', coalesce(p->'value', '{}'::jsonb))
  on conflict (key) do update set value = fin.settings.value || coalesce(p->'value', '{}'::jsonb), updated_at = now()
  returning value into v;
  return v;
end $$;

create or replace function public.fin_forecast_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return fin.forecast_set(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', 'finance')));
end $$;
create or replace function public.fin_settings_set(p jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return fin.settings_set(p);
end $$;

-- Amazon payouts (Finances API "Transfer" postings), in USD (Mexico converted with jt.settings amazon_fx)
create or replace view fin.v_amazon_payouts as
select f.transaction_id as id, f.posted_at, (f.posted_at at time zone 'America/Los_Angeles')::date as day,
       f.marketplace, f.currency, f.total as amount_local,
       round(f.total * case f.currency when 'USD' then 1
                                       else coalesce((select (value->>f.currency)::numeric from jt.settings where key = 'amazon_fx'), 1) end, 2) as amount
from jt.amazon_fin_lines f
where f.type = 'Transfer';

grant select on fin.forecast, fin.settings, fin.shopify_payouts, fin.v_amazon_payouts to fin_reader;
revoke all on function fin.forecast_set(jsonb), fin.settings_set(jsonb) from public;
revoke all on function public.fin_forecast_set(jsonb), public.fin_settings_set(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_forecast_set(jsonb), public.fin_settings_set(jsonb) from anon;
    grant execute on function public.fin_forecast_set(jsonb), public.fin_settings_set(jsonb) to authenticated;
  end if;
end $$;
