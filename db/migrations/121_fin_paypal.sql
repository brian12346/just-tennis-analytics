-- Finance › Shopify payouts › PayPal (Brian, Oct 11): PayPal works like a bank account between Shopify and the bank —
-- sales come in gross, PayPal keeps its fees, transfers go out to the bank. PayPal's activity download (CSV, uploaded on
-- the page) gives every balance-affecting transaction with its fee and the running balance. From it Seller Sage:
--   · books PayPal's fees a week at a time (Cost of goods sold:PayPal Fees debit, Paypal Clearing Account credit), and
--   · checks the Paypal Clearing Account: QuickBooks' balance against PayPal's own, explained item by item — sales in
--     PayPal vs payments marked in Shopify, transfers to the bank vs deposits categorized in QuickBooks, fees, other.

create table if not exists fin.paypal_tx (
  txn_id         text primary key,
  txn_at         timestamptz not null,
  day            date not null,
  name           text not null default '',
  type           text not null default '',
  status         text not null default '',
  currency       text not null default 'USD',
  gross          numeric not null default 0,
  fee            numeric not null default 0,       -- as PayPal shows it: negative = PayPal kept it
  net            numeric not null default 0,
  balance        numeric,                           -- PayPal balance after this transaction
  balance_impact text not null default '',          -- Credit | Debit | Memo (when the download has it)
  invoice        text not null default '',
  ref_txn        text not null default '',
  item           text not null default '',
  uploaded_at    timestamptz not null default now(),
  uploaded_by    text not null default '',
  file           text not null default ''
);
create index if not exists paypal_tx_day on fin.paypal_tx (day);

create table if not exists fin.paypal_weeks (
  week_end date primary key,
  posted   jsonb not null default '{}'::jsonb
);

update fin.settings set value = value || jsonb_build_object('paypal', jsonb_build_object(
  'clearing', 'Paypal Clearing Account', 'fees', 'Cost of goods sold:PayPal Fees', 'prefix', 'SSPPP'))
where key = 'shop_post' and not value ? 'paypal';

-- p = {file, rows: [{txn_id, at, day, name, type, status, currency, gross, fee, net, balance, impact, invoice, ref, item}]}
create or replace function public.fin_paypal_save(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n int; who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '');
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  insert into fin.paypal_tx (txn_id, txn_at, day, name, type, status, currency, gross, fee, net, balance, balance_impact, invoice, ref_txn, item, uploaded_at, uploaded_by, file)
  select distinct on (x->>'txn_id') x->>'txn_id', (x->>'at')::timestamptz, (x->>'day')::date, coalesce(x->>'name', ''), coalesce(x->>'type', ''), coalesce(x->>'status', ''),
         coalesce(nullif(x->>'currency', ''), 'USD'), coalesce((x->>'gross')::numeric, 0), coalesce((x->>'fee')::numeric, 0), coalesce((x->>'net')::numeric, 0),
         (x->>'balance')::numeric, coalesce(x->>'impact', ''), coalesce(x->>'invoice', ''), coalesce(x->>'ref', ''), coalesce(x->>'item', ''), now(), who, coalesce(p->>'file', '')
  from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) x where coalesce(x->>'txn_id', '') <> ''
  on conflict (txn_id) do update set txn_at = excluded.txn_at, day = excluded.day, name = excluded.name, type = excluded.type, status = excluded.status,
    currency = excluded.currency, gross = excluded.gross, fee = excluded.fee, net = excluded.net, balance = excluded.balance,
    balance_impact = excluded.balance_impact, invoice = excluded.invoice, ref_txn = excluded.ref_txn, item = excluded.item,
    uploaded_at = now(), uploaded_by = excluded.uploaded_by, file = excluded.file;
  get diagnostics n = row_count;
  return n;
end $$;

-- what each PayPal transaction is
create or replace view fin.v_paypal_tx as
select k.*, case when k.kind = 'fee' then -k.net when k.kind in ('sale', 'refund') then -k.fee else 0 end as fee_cost   -- + = what PayPal kept
from (
select t.*,
       case when t.balance_impact ilike 'memo' or t.status ilike any (array['denied', 'canceled', 'cancelled', 'voided', 'removed', 'failed']) then 'memo'
            when t.type ilike any (array['%withdraw%', '%transfer to bank%', '%bank account%']) and t.net < 0 then 'bank_out'
            when t.type ilike any (array['%bank deposit%', '%transfer from bank%', '%add funds%']) and t.net > 0 then 'bank_in'
            when t.type ilike any (array['%hold%', '%reserve%']) then 'hold'
            when t.type ilike any (array['%chargeback%', '%dispute%', '%reversal%']) and t.type not ilike '%hold%' then 'dispute'
            when t.type ilike '%refund%' then 'refund'
            when t.type ilike '%fee%' and t.gross <= 0 then 'fee'
            when t.type ilike '%payment%' and t.gross > 0 then 'sale'
            else 'other' end as kind,
       (t.day - extract(isodow from t.day)::int + 7) as week_end,
       t.fee as fee_raw
from fin.paypal_tx t) k;

-- PayPal sales paired with the PayPal payments marked in Shopify: same amount, within 3 days (nth with nth)
create or replace view fin.v_paypal_match as
with pp as (select txn_id, day, gross as amount, name, invoice, row_number() over (partition by gross order by txn_at, txn_id) as k
            from fin.v_paypal_tx where kind = 'sale' and day > (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post')),
sh as (select id, day, amount, order_name, row_number() over (partition by amount order by processed_at, id) as k
       from fin.v_shop_other_tx where lower(gateway) = 'paypal' and kind <> 'REFUND' and after_switch)
select coalesce(pp.amount, sh.amount) as amount, pp.txn_id, pp.day as paypal_day, pp.name, pp.invoice, sh.id as shopify_payment, sh.day as shopify_day, sh.order_name,
       case when pp.txn_id is not null and sh.id is not null and abs(pp.day - sh.day) <= 3 then 'matched'
            when pp.txn_id is null then 'shopify_only' when sh.id is null then 'paypal_only' else 'dates_apart' end as status
from pp full join sh on sh.amount = pp.amount and sh.k = pp.k;

-- a week of PayPal fees (and chargebacks): fees account debit, clearing account credit
create or replace view fin.v_paypal_weeks as
select x.week_end, x.week_end - 6 as week_start, coalesce(w.posted, '{}'::jsonb) as posted,
       x.week_end < (now() at time zone 'America/Los_Angeles')::date as complete,
       count(*) as tx, sum(x.fee_cost) as fees, sum(x.net) filter (where x.kind = 'dispute') as disputes,
       sum(x.gross) filter (where x.kind = 'sale') as sales, sum(x.gross) filter (where x.kind = 'refund') as refunds,
       sum(x.net) filter (where x.kind = 'bank_out') as to_bank, sum(x.net) filter (where x.kind = 'other') as other
from fin.v_paypal_tx x left join fin.paypal_weeks w on w.week_end = x.week_end
where x.kind <> 'memo' and x.day > (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post')
group by x.week_end, w.posted;

create or replace function fin.paypal_fee_entry(we date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  w record; cfg jsonb := coalesce((select value->'paypal' from fin.settings where key = 'shop_post'), '{}'::jsonb);
  lines jsonb; doc text; probs jsonb := '[]'::jsonb; f numeric; d numeric; nf int; nd int; oth int;
begin
  select * into w from fin.v_paypal_weeks where week_end = we;
  if not found then return null; end if;
  select coalesce(sum(fee_cost), 0), count(*) filter (where fee_cost <> 0),
         coalesce(sum(-net) filter (where kind = 'dispute'), 0), count(*) filter (where kind = 'dispute'), count(*) filter (where kind = 'other')
    into f, nf, d, nd, oth
  from fin.v_paypal_tx where week_end = we and kind <> 'memo';
  doc := coalesce(cfg->>'prefix', 'SSPPP') || '-' || to_char(we, 'DDMon') || '-FEE';
  lines := jsonb_build_array(
    jsonb_build_object('account', coalesce(cfg->>'fees', 'Cost of goods sold:PayPal Fees'), 'amount', round(f, 2), 'description', format('PayPal fees · %s transaction%s', nf, case when nf = 1 then '' else 's' end)),
    jsonb_build_object('account', coalesce(cfg->>'fees', 'Cost of goods sold:PayPal Fees'), 'amount', round(d, 2), 'description', format('Chargebacks and reversals · %s', nd)),
    jsonb_build_object('account', coalesce(cfg->>'clearing', 'Paypal Clearing Account'), 'amount', -round(f + d, 2), 'description', 'Kept by PayPal, week ending ' || to_char(we, 'Mon DD')));
  select coalesce(jsonb_agg(l), '[]'::jsonb) into lines from jsonb_array_elements(lines) l where round((l->>'amount')::numeric, 2) <> 0;
  if not w.complete then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', 'This week isn''t over yet — post it after ' || to_char(we, 'Mon DD') || '.'));
  end if;
  if oth > 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'other', 'message', oth || ' PayPal transaction(s) that week aren''t Shopify sales, refunds, fees or bank transfers (purchases, conversions …). Categorize those in QuickBooks yourself.'));
  end if;
  return jsonb_build_object('week', to_jsonb(w), 'problems', probs,
    'parts', case when jsonb_array_length(lines) = 0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object('doc', doc, 'date', we, 'kind', 'main', 'currency', 'USD', 'fx', 1, 'lines', lines, 'posted', w.posted->doc)) end);
end $$;
revoke all on function fin.paypal_fee_entry(date) from public;

create or replace function public.fin_paypal_fee_entry(we date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (fin.is_user() or coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return fin.paypal_fee_entry(we);
end $$;

create or replace function public.fin_paypal_week_posted(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into fin.paypal_weeks (week_end) values ((p->>'week_end')::date) on conflict do nothing;
  update fin.paypal_weeks set posted = posted || jsonb_build_object(p->>'doc', jsonb_build_object('id', p->>'id', 'at', now(), 'by', coalesce(p->>'by', ''), 'how', coalesce(p->>'how', 'created')))
  where week_end = (p->>'week_end')::date and coalesce(p->>'id', '') <> '';
  return found;
end $$;

-- the check: QuickBooks' Paypal Clearing Account against PayPal's balance. Since the switch each side moves with the same
-- things — sales, refunds, fees, transfers to the bank, other — so the difference splits into a gap per kind, plus
-- whatever was already off before the switch.
create or replace view fin.v_paypal_check as
with u as (select (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post') as until),
cfg as (select coalesce((select value->'paypal'->>'clearing' from fin.settings where key = 'shop_post'), 'Paypal Clearing Account') as acct),
last as (select balance, day from fin.paypal_tx where balance is not null and balance_impact not ilike 'memo' order by txn_at desc, txn_id desc limit 1),
up as (select min(day) as first_day, max(day) as last_day, count(*) as n from fin.paypal_tx),
pp as (select coalesce(sum(gross) filter (where kind = 'sale'), 0) as sales, coalesce(sum(gross) filter (where kind = 'refund'), 0) as refunds,
              coalesce(sum(fee_cost), 0) as fees, coalesce(sum(net) filter (where kind = 'dispute'), 0) as disputes,
              coalesce(sum(net) filter (where kind = 'bank_out'), 0) as to_bank,
              coalesce(sum(net) filter (where kind in ('bank_in', 'hold', 'other')), 0) as other, count(*) filter (where kind = 'other') as other_n
       from fin.v_paypal_tx, u where kind <> 'memo' and day > u.until),
sh as (select coalesce(sum(x.amount) filter (where x.kind <> 'REFUND'), 0) as paid, coalesce(sum(x.amount) filter (where x.kind = 'REFUND'), 0) as refunded,
              coalesce(sum(x.amount) filter (where x.kind <> 'REFUND' and coalesce(w.posted, '{}'::jsonb) <> '{}'::jsonb), 0) as paid_posted,
              coalesce(sum(x.amount) filter (where x.kind = 'REFUND' and coalesce(w.posted, '{}'::jsonb) <> '{}'::jsonb), 0) as refunded_posted
       from fin.v_shop_other_tx x left join fin.shop_pay_weeks w on w.week_end = x.week_end where lower(x.gateway) = 'paypal' and x.after_switch),
qb as (select coalesce(sum(c.amount) filter (where c.txn_type in ('Deposit', 'Transfer') and c.amount < 0), 0) as deposits,
              coalesce(sum(c.amount) filter (where not (c.txn_type in ('Deposit', 'Transfer') and c.amount < 0)), 0) as other_in
       from fin.qbo_clearing c, u, cfg where c.account = cfg.acct and c.txn_date > u.until and c.doc not like 'SSP%'),
fp as (select coalesce(sum((l->>'amount')::numeric), 0) as fees_posted
       from fin.paypal_weeks w cross join lateral jsonb_array_elements(fin.paypal_fee_entry(w.week_end)->'parts'->0->'lines') l, cfg
       where w.posted <> '{}'::jsonb and l->>'account' = cfg.acct),
m as (select count(*) filter (where status = 'paypal_only') as paypal_only, count(*) filter (where status = 'shopify_only') as shopify_only,
             count(*) filter (where status = 'dates_apart') as dates_apart,
             coalesce(sum(amount) filter (where status = 'paypal_only'), 0) as paypal_only_amt, coalesce(sum(amount) filter (where status = 'shopify_only'), 0) as shopify_only_amt
      from fin.v_paypal_match)
select cfg.acct as account, last.balance as paypal_balance, last.day as paypal_balance_day, up.first_day, up.last_day, up.n as uploaded,
       b.balance as qbo_balance, b.synced_at as qbo_synced_at, round(coalesce(b.balance, 0) - coalesce(last.balance, 0), 2) as difference, u.until as since,
       -- each kind: QuickBooks side, PayPal side (money into the PayPal account is +)
       sh.paid_posted as qb_sales, pp.sales as pp_sales, sh.paid - sh.paid_posted as sales_unposted,
       sh.refunded_posted as qb_refunds, pp.refunds as pp_refunds,
       fp.fees_posted as qb_fees, -pp.fees + pp.disputes as pp_fees, pp.fees as pp_fee_cost, pp.disputes as pp_disputes,
       qb.deposits as qb_to_bank, pp.to_bank as pp_to_bank,
       qb.other_in as qb_other, pp.other as pp_other, pp.other_n as pp_other_n,
       sh.paid as shopify_paid, sh.refunded as shopify_refunded,
       m.paypal_only, m.shopify_only, m.dates_apart, m.paypal_only_amt, m.shopify_only_amt
from cfg cross join u cross join up cross join pp cross join sh cross join qb cross join fp cross join m
left join last on true left join fin.qbo_clearing_balances b on b.account = cfg.acct;

revoke all on function public.fin_paypal_save(jsonb), public.fin_paypal_fee_entry(date), public.fin_paypal_week_posted(jsonb) from public;
grant select on fin.paypal_tx, fin.v_paypal_tx, fin.v_paypal_match, fin.v_paypal_weeks, fin.v_paypal_check to fin_reader;
grant execute on function fin.paypal_fee_entry(date) to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_paypal_save(jsonb), public.fin_paypal_fee_entry(date), public.fin_paypal_week_posted(jsonb) from anon;
    grant execute on function public.fin_paypal_save(jsonb), public.fin_paypal_fee_entry(date) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_paypal_fee_entry(date), public.fin_paypal_week_posted(jsonb) to service_role;
  end if;
end $$;
