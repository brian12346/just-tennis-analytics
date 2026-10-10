-- Finance › Profit (Brian, Oct 9): don't take the whole P&L off — build overall profit from the costs he picks. For now
-- only payroll is counted: the QuickBooks "Payroll expenses" accounts (wages and payroll taxes). Every other account
-- starts out not counted (it keeps a suggested group for when it's switched on in "Add a cost").

create or replace function fin.pl_default(section text, account text, parent text) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'include', section = 'Expenses' and (coalesce(parent, '') ~* '^payroll expenses' or coalesce(account, '') ~* '^payroll expenses$'),
    'grp', case
      when section in ('Income', 'COGS') then 'In dashboard profit'
      when section = 'OtherIncome' then 'Other income'
      when coalesce(parent, '') ~* '^payroll expenses' or coalesce(account, '') ~* '^payroll expenses$' then 'Payroll'
      when t ~* 'wage|salar|workers.? comp|employee benefit|contract labor|uniform' then 'Staff costs'
      when t ~* 'advertis|marketing|google ads|facebook|meta ads|promotion' then 'Advertising'
      when t ~* 'rent|lease|utilit|internet|phone|cleaning|janitor|repair|maintenance' then 'Rent & facilities'
      when t ~* 'software|apps|subscription|membership' then 'Software & subscriptions'
      when t ~* 'meal|lunch|travel|hotel|airfare|taxi|ride|vehicle|mileage' then 'Meals & travel'
      when t ~* 'insurance' then 'Insurance'
      when t ~* 'interest|bank fee|service charge|loan' then 'Bank fees & interest'
      when t ~* 'tax' then 'Taxes'
      when t ~* 'accounting|legal|professional' then 'Professional fees'
      else 'Other expenses' end)
  from (select coalesce(parent, '') || ' › ' || coalesce(account, '') as t) x;
$$;
