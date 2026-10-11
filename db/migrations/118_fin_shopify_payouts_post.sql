-- Finance › Shopify payouts (Brian, Oct 10): Just Tennis's Shopify Payments payouts -> QuickBooks journal entries, the
-- simple way (not A2X's channel-by-channel layout): one entry per payout, dated the payout day, with one line per kind
-- of money — sales, shipping, sales tax, refunds, Shopify's fees, chargebacks, Shop Cash, tax adjustments — and the
-- payout to BofA (0364); plus a cost-of-goods entry at Seller Sage's costs. Reviewed on the page, then sent with "Send to
-- QuickBooks" (never automatic). Built from Shopify Payments' balance transactions (jt.shopify_payment_tx), each now
-- tagged with the payout it was paid in. Other gateways (PayPal, cash, manual) aren't in payouts and aren't covered yet.

alter table jt.shopify_payment_tx add column if not exists payout_id text not null default '';
create index if not exists shopify_payment_tx_payout on jt.shopify_payment_tx (store, payout_id);

alter table fin.shopify_payouts add column if not exists posted jsonb not null default '{}'::jsonb;     -- {doc: {id, at, by, how}}
alter table fin.shopify_payouts add column if not exists a2x_docs text[] not null default '{}';          -- A2X's entry for it, if A2X posted it
alter table fin.shopify_payouts add column if not exists checked_at timestamptz;                          -- last looked for in QuickBooks

insert into fin.settings (key, value) values ('shop_post', jsonb_build_object(
  'bank', 'BofA (0364)', 'sales', 'Shopify Sales', 'shipping', 'Shopify Sales:Shopify Shipping', 'tax', 'Shopify Sales Tax Collected',
  'refunds', 'Shopify Sales:Shopify Refunds', 'fees', 'Cost of goods sold:Shopify Fees', 'cogs', 'Cost of goods sold', 'inventory', 'Inventory',
  'prefix', 'SSPSH', 'start', '2026-10-01'))
on conflict (key) do nothing;

-- every Just Tennis Shopify Payments transaction paid in a payout, split into what it is. A charge is split like its
-- order: tax and shipping in the order's proportions (rounded to the cent), the rest is sales (after discounts). A
-- refund's tax is split off the same way. Cost of goods: the order's cost (Seller Sage's costs, after returns) times the
-- share of the order this charge paid.
create or replace view fin.v_shop_tx as
with t as (
  select t.*, o.total as o_total, o.tax as o_tax, o.shipping as o_shipping, o.name as o_name,
         case when t.type = 'CHARGE' then 'charge' when t.type = 'REFUND' then 'refund' when t.type like 'DISPUTE%' then 'dispute'
              when t.type like 'SHOP_CASH%' then 'shopcash' when t.type like 'TAX_ADJUSTMENT%' then 'taxadj' else 'other' end as kind
  from jt.shopify_payment_tx t left join jt.shopify_orders o on o.order_id = t.order_id
  where t.store = 'justtennis' and not t.test and t.payout_id <> ''),
s as (
  select t.*,
         case when kind in ('charge', 'refund') and o_total > 0 then round(amount * least(1, greatest(0, o_tax / o_total)), 2) else 0 end as tax_part,
         case when kind = 'charge' and o_total > 0 then round(amount * least(1, greatest(0, o_shipping / o_total)), 2) else 0 end as ship_part
  from t)
select s.store, s.id, s.payout_id, s.type, s.kind, s.processed_at, s.order_id, coalesce(nullif(s.order_name, ''), s.o_name, '') as order_name,
       s.amount, s.fee, s.net, s.tax_part, s.ship_part,
       case when s.kind = 'charge' then s.amount - s.tax_part - s.ship_part else 0 end as sales_part,
       case when s.kind = 'refund' then s.amount - s.tax_part else 0 end as refund_part,
       case when s.kind = 'charge' and s.order_id is not null then
         round(coalesce(c.cogs, 0) * case when s.o_total > 0 then least(1, greatest(0, s.amount / s.o_total)) else 1 end, 2) else 0 end as cogs,
       case when s.kind = 'charge' and coalesce(c.no_cost, 0) > 0 then true else false end as missing_cost
from s
left join lateral (select sum(a.cogs + a.cost_added) as cogs, sum(a.net_no_cost_adj) as no_cost from jt.v_sales_adjusted a where a.order_id = s.order_id) c on s.kind = 'charge';

-- one row per payout: what's in it (+ = money to Just Tennis) and its cost of goods
create or replace view fin.v_shop_payouts as
select p.id, p.issued_at, (p.issued_at at time zone 'UTC')::date as payout_date, p.status, p.amount, p.currency, p.posted, p.a2x_docs, p.checked_at, p.synced_at,
       count(x.id) as tx, count(distinct x.order_id) filter (where x.kind = 'charge') as orders,
       coalesce(sum(x.sales_part), 0) as sales, coalesce(sum(x.ship_part), 0) as shipping,
       coalesce(sum(x.tax_part), 0) + coalesce(sum(x.amount) filter (where x.kind = 'taxadj'), 0) as tax,
       coalesce(sum(x.refund_part), 0) as refunds,
       -coalesce(sum(x.fee), 0) as fees,
       coalesce(sum(x.amount) filter (where x.kind in ('dispute', 'shopcash', 'other')), 0) as other,
       coalesce(sum(x.net), 0) as net, coalesce(sum(x.cogs), 0) as cogs,
       count(distinct x.order_id) filter (where x.missing_cost) as orders_missing_cost
from fin.shopify_payouts p
left join fin.v_shop_tx x on x.payout_id = p.id
group by p.id;

-- The journal entries for one payout: {payout, parts: [{doc, date, kind: main|cogs, currency, fx, lines: [{account,
-- amount (+ debit, − credit), description, review}], posted}], problems}. The page shows it; amzpay (shop_post) posts it.
create or replace function fin.shop_entry(pid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  p record; cfg jsonb := coalesce((select value from fin.settings where key = 'shop_post'), '{}'::jsonb);
  x record; lines jsonb := '[]'::jsonb; out jsonb := '[]'::jsonb; probs jsonb := '[]'::jsonb; doc text; cdoc text; others text;
begin
  select * into p from fin.v_shop_payouts where id = pid;
  if not found then return null; end if;
  doc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(p.payout_date, 'DDMon') || '-' || right(pid, 3);
  cdoc := coalesce(cfg->>'prefix', 'SSPSH') || '-' || to_char(p.payout_date, 'DDMon') || 'C' || right(pid, 3);
  select count(*) filter (where kind = 'charge') as charges, count(distinct order_id) filter (where kind = 'charge') as orders,
         count(*) filter (where kind = 'refund') as refunds, count(*) filter (where kind = 'dispute') as disputes,
         coalesce(sum(sales_part), 0) as sales, coalesce(sum(ship_part), 0) as ship,
         coalesce(sum(tax_part) filter (where kind = 'charge'), 0) as tax_in, coalesce(sum(tax_part) filter (where kind = 'refund'), 0) as tax_out,
         coalesce(sum(refund_part), 0) as refund, coalesce(sum(fee), 0) as fee,
         coalesce(sum(amount) filter (where kind = 'dispute'), 0) as dispute, coalesce(sum(amount) filter (where kind = 'shopcash'), 0) as shopcash,
         coalesce(sum(amount) filter (where kind = 'taxadj'), 0) as taxadj, coalesce(sum(amount) filter (where kind = 'other'), 0) as other,
         coalesce(sum(net), 0) as net, coalesce(sum(cogs), 0) as cogs
    into x from fin.v_shop_tx where payout_id = pid;
  select string_agg(distinct type, ', ') into others from fin.v_shop_tx where payout_id = pid and kind = 'other';
  -- + = debit, − = credit; money in (sales, shipping, tax) is a credit
  lines := jsonb_build_array(
    jsonb_build_object('account', cfg->>'sales', 'amount', -x.sales, 'description', format('Sales after discounts · %s order%s', x.orders, case when x.orders = 1 then '' else 's' end)),
    jsonb_build_object('account', cfg->>'shipping', 'amount', -x.ship, 'description', 'Shipping charged'),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.tax_in, 'description', 'Sales tax collected'),
    jsonb_build_object('account', cfg->>'refunds', 'amount', -x.refund, 'description', format('Refunds · %s', x.refunds)),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.tax_out, 'description', 'Sales tax refunded'),
    jsonb_build_object('account', cfg->>'tax', 'amount', -x.taxadj, 'description', 'Tax adjustments (tax Shopify remits, e.g. Shop app orders)'),
    jsonb_build_object('account', cfg->>'fees', 'amount', x.fee, 'description', 'Shopify Payments fees'),
    jsonb_build_object('account', cfg->>'fees', 'amount', -x.dispute, 'description', format('Chargebacks · %s', x.disputes)),
    jsonb_build_object('account', cfg->>'fees', 'amount', -x.shopcash, 'description', 'Shop Cash'),
    jsonb_build_object('account', cfg->>'fees', 'amount', -x.other, 'description', 'Other: ' || coalesce(others, ''), 'review', true));
  select coalesce(jsonb_agg(l), '[]'::jsonb) into lines from jsonb_array_elements(lines) l where round((l->>'amount')::numeric, 2) <> 0;
  lines := lines || jsonb_build_array(jsonb_build_object('account', cfg->>'bank', 'amount', p.amount,
    'description', 'Shopify payout ' || to_char(p.payout_date, 'YYYY-MM-DD') || ' (#' || pid || ')'));
  out := jsonb_build_array(jsonb_build_object('doc', doc, 'date', p.payout_date, 'kind', 'main', 'currency', p.currency, 'fx', 1, 'lines', lines, 'posted', p.posted->doc));
  if round(x.cogs, 2) <> 0 then
    out := out || jsonb_build_array(jsonb_build_object('doc', cdoc, 'date', p.payout_date, 'kind', 'cogs', 'currency', 'USD', 'fx', 1, 'posted', p.posted->cdoc,
      'lines', jsonb_build_array(
        jsonb_build_object('account', cfg->>'cogs', 'amount', round(x.cogs, 2), 'description', format('Cost of goods sold · %s Shopify order%s', x.orders, case when x.orders = 1 then '' else 's' end)),
        jsonb_build_object('account', cfg->>'inventory', 'amount', -round(x.cogs, 2), 'description', 'Inventory deduction (Shopify sales)'))));
  end if;
  if x.charges + x.refunds + x.disputes = 0 and round(x.net, 2) = 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', 'No Shopify Payments transactions are linked to this payout yet — they come in with the hourly Shopify sync.'));
  elsif round(x.net, 2) <> round(p.amount, 2) then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', format('The transactions add to %s but the payout is %s — some may not have come in from Shopify yet.', round(x.net, 2), p.amount)));
  end if;
  if p.currency <> 'USD' then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'total', 'message', 'This payout isn''t in USD.'));
  end if;
  if p.orders_missing_cost > 0 then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'cost', 'message', p.orders_missing_cost || ' order(s) have items with no cost, so those items are left out of cost of goods.'));
  end if;
  if others is not null then
    probs := probs || jsonb_build_array(jsonb_build_object('kind', 'other', 'message', 'Some transactions aren''t sales, refunds, fees, chargebacks, Shop Cash or tax adjustments (' || others || ') — they''re on the fees account; check them.'));
  end if;
  return jsonb_build_object('payout', to_jsonb(p), 'parts', out, 'problems', probs);
end $$;
revoke all on function fin.shop_entry(text) from public;

create or replace function public.fin_shop_entry(pid text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (fin.is_user() or coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', '') = 'service_role') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return fin.shop_entry(pid);
end $$;

-- p = {payout_id, doc?, id?, how?, by?, a2x?: [...], checked?: true}: what QuickBooks has for a payout
create or replace function public.fin_shop_posted(p jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update fin.shopify_payouts set
    posted = case when p ? 'doc' and coalesce(p->>'id', '') <> '' then posted || jsonb_build_object(p->>'doc', jsonb_build_object('id', p->>'id', 'at', now(), 'by', coalesce(p->>'by', ''), 'how', coalesce(p->>'how', 'created')))
                  when p ? 'doc' and p ? 'id' and coalesce(p->>'id', '') = '' then posted - (p->>'doc') else posted end,
    a2x_docs = case when p ? 'a2x' then array(select jsonb_array_elements_text(p->'a2x')) else a2x_docs end,
    checked_at = case when coalesce((p->>'checked')::boolean, false) then now() else checked_at end
  where id = p->>'payout_id';
  return found;
end $$;

-- payouts to look for in QuickBooks: not posted, from two weeks before the switch on
create or replace function public.fin_shop_open_ids() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(p.id order by p.issued_at), '{}') from fin.shopify_payouts p
  where p.posted = '{}'::jsonb and cardinality(p.a2x_docs) = 0 and p.status = 'PAID'
    and p.issued_at >= (coalesce((select value->>'start' from fin.settings where key = 'shop_post'), '2026-10-01'))::date - 14
$$;

revoke all on function public.fin_shop_entry(text), public.fin_shop_posted(jsonb), public.fin_shop_open_ids() from public;
grant select on fin.v_shop_tx, fin.v_shop_payouts to fin_reader;
grant execute on function fin.shop_entry(text) to fin_reader;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_shop_entry(text), public.fin_shop_posted(jsonb), public.fin_shop_open_ids() from anon;
    grant execute on function public.fin_shop_entry(text) to authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.fin_shop_entry(text), public.fin_shop_posted(jsonb), public.fin_shop_open_ids() to service_role;
  end if;
end $$;
