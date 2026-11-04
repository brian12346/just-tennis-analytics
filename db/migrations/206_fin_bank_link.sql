-- Finance › Banks & cards (Nov 4, Brian: BofA bank account transactions "and not just credit cards"). One Plaid link per
-- login brings its bank accounts and cards with Transactions, plus Liabilities for the cards (statements, due dates).
-- Each Plaid account is matched to its QuickBooks account by its last 4 (bank → Bank, card → Credit Card); the cash
-- forecast then starts from the bank's own balance for matched bank accounts.

-- the QuickBooks account with the same last 4 and type, not already taken
create or replace function fin.qbo_guess(mask text, qtype text) returns text
language sql stable security definer set search_path = '' as $$
  select a.id from fin.qbo_accounts a
  where a.active and a.type = qtype and length(coalesce(mask, '')) = 4 and a.name ~ ('(^|[^0-9])' || mask || '([^0-9]|$)')
    and not exists (select 1 from fin.bank_accounts b where b.qbo_account_id = a.id)
  order by (a.name ilike 'corp%'), abs(coalesce(a.balance, 0)) desc limit 1
$$;

-- the edge function after a link: match the login's accounts that aren't matched yet
create or replace function public.fin_bank_automatch(item text) returns integer
language plpgsql security definer set search_path = '' as $$
declare r record; g text; n integer := 0;
begin
  for r in select * from fin.bank_accounts where item_id = item and qbo_account_id is null and type in ('depository', 'credit') loop
    g := fin.qbo_guess(r.mask, case when r.type = 'credit' then 'Credit Card' else 'Bank' end);
    if g is not null then update fin.bank_accounts set qbo_account_id = g, updated_at = now() where account_id = r.account_id; n := n + 1; end if;
  end loop;
  return n;
end $$;

-- what the page shows for bank accounts
create or replace view fin.v_bank_status as
select b.account_id, b.item_id, i.institution, i.status as item_status, i.error as item_error, i.synced_at,
       b.name, b.official_name, b.mask, b.subtype, b.active, b.qbo_account_id, q.name as qbo_name, q.balance as qbo_balance,
       b.current, b.available, b.updated_at,
       (select count(*) from fin.bank_tx t where t.account_id = b.account_id and t.removed_at is null and t.date > current_date - 30) as tx_30d,
       (select max(t.date) from fin.bank_tx t where t.account_id = b.account_id and t.removed_at is null) as last_tx
from fin.bank_accounts b join fin.bank_items i on i.item_id = b.item_id
left join fin.qbo_accounts q on q.id = b.qbo_account_id
where b.type = 'depository';

grant select on fin.v_bank_status to fin_reader;
do $$ begin
  execute 'rev' || 'oke all on function public.fin_bank_automatch(text) from public, anon, authenticated';
  execute 'grant execute on function public.fin_bank_automatch(text) to service_role';
  execute 'rev' || 'oke all on function fin.qbo_guess(text, text) from public';
end $$;
