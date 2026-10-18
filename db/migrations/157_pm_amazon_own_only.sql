-- Amazon prices aren't used for Shopify prices any more (Brian, Oct 18: "amazon prices should not be included in the
-- shopify prices"). The pm-amazon step now only prices our own in-stock listings (Price match › Amazon); it no longer
-- looks up UPCs for the Shopify catalog. sync/price_match.py restores prices it lowered to meet Amazon earlier.
create or replace function public.jt_pm_amazon_todo(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare n_asin int := coalesce((p->>'asins')::int, 200); r jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  with due as (
    select s.asin, max(pr.checked_at) as checked from (select distinct asin from jt.v_pm_amazon_stock) s
    left join jt.pm_amazon_prices pr on pr.asin = s.asin
    where pr.asin is null or pr.checked_at < now() - interval '18 hours' group by s.asin
  )
  select jsonb_build_object(
    'upcs', '[]'::jsonb,
    'asins', coalesce((select jsonb_agg(d.asin) from (select asin from due order by checked nulls first limit n_asin) d), '[]'::jsonb),
    'left_upcs', 0,
    'left_asins', (select count(*) from due))
  into r;
  return r;
end $$;

update jt.settings set value = value || '{"amazon": false}'::jsonb, updated_at = now() where key = 'price_match';
