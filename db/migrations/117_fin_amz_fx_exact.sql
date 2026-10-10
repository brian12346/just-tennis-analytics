-- Finance › Amazon payouts (Oct 10): the exchange rate on a Mexico/Canada entry must turn the payout into exactly the
-- USD that reached the bank, or QuickBooks can't match the deposit. A rate rounded to 6 places was a cent off
-- (MX$35,242.71 × 0.054013 = $1,903.56; Amazon paid $1,903.55). Use the shortest rate (6–10 places) that gives the
-- paid amount to the cent.
create or replace view fin.v_amz_settlements as
select s.*, g.group_id, g.converted as converted_usd, g.transfer as transfer_status, g.transfer_at,
       case when s.currency = 'USD' then 1
            when g.converted is not null and g.original <> 0 then
              coalesce((select round(g.converted / g.original, k) from generate_series(6, 10) k
                        where round(g.original * round(g.converted / g.original, k), 2) = g.converted order by k limit 1),
                       round(g.converted / g.original, 10))
            else (select (value->>s.currency)::numeric from jt.settings where key = 'amazon_fx') end as fx,
       (select coalesce(sum(u.qty), 0) from fin.amz_settlement_units u where u.settlement_id = s.settlement_id) as units
from fin.amz_settlements s
left join lateral (select * from fin.amz_event_groups g where g.currency = s.currency and abs(extract(epoch from g.start_at - s.start_at)) < 3600
                   order by abs(extract(epoch from g.start_at - s.start_at)) limit 1) g on true;
