-- Finance › Amazon payouts (Brian, Oct 10): each payout shown with what's in it — sales, refunds and promotions,
-- reimbursements, Amazon's fees, ads, other — and its cost of goods at Seller Sage's costs; and the product costs (Seller
-- Sage's) for every SKU sold in the settlements on the page. (The A2X cost comparison is off the page; Seller Sage's
-- costs are the ones used.)

-- per settlement, the payout by kind of amount (settlement currency; + = money to Just Tennis), from the mapping
create or replace view fin.v_amz_settlement_summary as
with k as (
  select x.settlement_id, x.amount,
         case when a.account in ('Amazon Sales', 'Amazon Sales:Amazon Shipping') then 'sales'
              when a.account in ('Amazon Sales:Amazon Refunds', 'Amazon Sales:Amazon Promotions') then 'refunds'
              when a.account = 'Amazon Sales:Amazon Reimbursement' then 'reimb'
              when a.account in ('Amazon FBA Fees', 'Amazon Seller Fees and Charges', 'Amazon Shipping Fees') then 'fees'
              when a.account ilike '%advertising%' then 'ads'
              when a.account ilike '%tax%' then 'tax'
              else 'other' end as kind
  from fin.amz_settlement_sums x cross join lateral fin.amz_account(x.transaction_type, x.amount_type, x.amount_description) a
  where x.amount <> 0),
c as (
  select u.settlement_id, sum(u.qty) as units, round(sum(u.qty * m.cost), 2) as cogs,
         sum(u.qty) filter (where m.cost is null) as units_no_cost
  from fin.amz_settlement_units u left join jt.mv_amz_sku_cost m on m.sku = u.sku
  where u.qty <> 0 group by 1)
select s.settlement_id,
       coalesce(sum(k.amount) filter (where k.kind = 'sales'), 0) as sales,
       coalesce(sum(k.amount) filter (where k.kind = 'refunds'), 0) as refunds,
       coalesce(sum(k.amount) filter (where k.kind = 'reimb'), 0) as reimbursements,
       coalesce(sum(k.amount) filter (where k.kind = 'fees'), 0) as fees,
       coalesce(sum(k.amount) filter (where k.kind = 'ads'), 0) as ads,
       coalesce(sum(k.amount) filter (where k.kind = 'tax'), 0) as tax,
       coalesce(sum(k.amount) filter (where k.kind = 'other'), 0) as other,
       coalesce(max(c.units), 0) as units, coalesce(max(c.cogs), 0) as cogs, coalesce(max(c.units_no_cost), 0) as units_no_cost
from fin.amz_settlements s
left join k on k.settlement_id = s.settlement_id
left join c on c.settlement_id = s.settlement_id
group by s.settlement_id;

-- Seller Sage's cost for every SKU sold in the settlements on the page (the last 90 days of payouts)
create or replace view fin.v_amz_sku_costs as
select u.sku, sum(u.qty) as units, count(distinct u.settlement_id) as settlements, string_agg(distinct s.market, '/') as markets,
       string_agg(distinct u.fulfillment, '/') as fulfillment,
       m.cost, m.map_units, v.display_name as name, v.unit_cost as shopify_unit_cost,
       round(sum(u.qty) * m.cost, 2) as cogs
from fin.amz_settlement_units u
join fin.amz_settlements s using (settlement_id)
left join jt.mv_amz_sku_cost m on m.sku = u.sku
left join jt.variants v on v.variant_id = m.variant_id
where u.qty <> 0
group by u.sku, m.cost, m.map_units, v.display_name, v.unit_cost;

grant select on fin.v_amz_settlement_summary, fin.v_amz_sku_costs to fin_reader;
