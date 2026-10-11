-- Finance › Shopify payouts › PayPal (Brian, Oct 11): "let's do the paypal reconcile monthly rather than weekly". PayPal's
-- fees are booked one entry per calendar month (dated the month's last day, SSPPP-31Oct-FEE), not per week. Only PayPal
-- activity after the switch counts (the first month starts Sep 28). Posted entries are still kept in fin.paypal_weeks,
-- keyed by the period's last day.

-- (the month of a PayPal transaction: (date_trunc('month', day) + 1 month − 1 day), worked out where it's used)

-- a month of PayPal activity since the switch
create or replace view fin.v_paypal_months as
select (date_trunc('month', x.day) + interval '1 month - 1 day')::date as month_end, greatest(date_trunc('month', x.day)::date, (select (value->>'a2x_until')::date + 1 from fin.settings where key = 'shop_post')) as month_start,
       coalesce(w.posted, '{}'::jsonb) as posted, (date_trunc('month', x.day) + interval '1 month - 1 day')::date < (now() at time zone 'America/Los_Angeles')::date as complete,
       count(*) as tx, sum(x.fee_cost) as fees, sum(x.net) filter (where x.kind = 'dispute') as disputes,
       sum(x.gross) filter (where x.kind = 'sale') as sales, sum(x.gross) filter (where x.kind = 'refund') as refunds,
       sum(x.net) filter (where x.kind = 'bank_out') as to_bank, sum(x.net) filter (where x.kind = 'other') as other
from fin.v_paypal_tx x left join fin.paypal_weeks w on w.week_end = (date_trunc('month', x.day) + interval '1 month - 1 day')::date
where x.kind <> 'memo' and x.day > (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post')
group by 1, 2, w.posted;

create or replace function fin.paypal_fee_entry(we date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  w record; cfg jsonb := coalesce((select value->'paypal' from fin.settings where key = 'shop_post'), '{}'::jsonb);
  lines jsonb; doc text; probs jsonb := '[]'::jsonb; f numeric; d numeric; nf int; nd int; oth int;
begin
  select * into w from fin.v_paypal_months where month_end = we;
  if not found then return null; end if;
  select coalesce(sum(fee_cost), 0), count(*) filter (where fee_cost <> 0),
         coalesce(sum(-net) filter (where kind = 'dispute'), 0), count(*) filter (where kind = 'dispute'), count(*) filter (where kind = 'other')
    into f, nf, d, nd, oth
  from fin.v_paypal_tx where (date_trunc('month', day) + interval '1 month - 1 day')::date = we and kind <> 'memo'
    and day > (select (value->>'a2x_until')::date from fin.settings where key = 'shop_post');
  doc := coalesce(cfg->>'prefix', 'SSPPP') || '-' || to_char(we, 'DDMon') || '-FEE';
  lines := jsonb_build_array(
    jsonb_build_object('account', coalesce(cfg->>'fees', 'Cost of goods sold:PayPal Fees'), 'amount', round(f, 2), 'description', format('PayPal fees · %s transaction%s', nf, case when nf = 1 then '' else 's' end)),
    jsonb_build_object('account', coalesce(cfg->>'fees', 'Cost of goods sold:PayPal Fees'), 'amount', round(d, 2), 'description', format('Chargebacks and reversals · %s', nd)),
    jsonb_build_object('account', coalesce(cfg->>'clearing', 'Paypal Clearing Account'), 'amount', -round(f + d, 2), 'description', 'Kept by PayPal, ' || to_char(we, 'FMMonth YYYY')));
  select coalesce(jsonb_agg(l), '[]'::jsonb) into lines from jsonb_array_elements(lines) l where round((l->>'amount')::numeric, 2) <> 0;
  if not w.complete then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', 'This month isn''t over yet — post it after ' || to_char(we, 'Mon DD') || '.'));
  end if;
  if oth > 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'other', 'message', oth || ' PayPal transaction(s) that month aren''t Shopify sales, refunds, fees or bank transfers (purchases, conversions …). Categorize those in QuickBooks yourself.'));
  end if;
  return jsonb_build_object('week', to_jsonb(w) || jsonb_build_object('week_end', we), 'problems', probs,
    'parts', case when jsonb_array_length(lines) = 0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object('doc', doc, 'date', we, 'kind', 'main', 'currency', 'USD', 'fx', 1, 'lines', lines, 'posted', w.posted->doc)) end);
end $$;
revoke all on function fin.paypal_fee_entry(date) from public;
grant select on fin.v_paypal_months to fin_reader;
grant execute on function fin.paypal_fee_entry(date) to fin_reader;
