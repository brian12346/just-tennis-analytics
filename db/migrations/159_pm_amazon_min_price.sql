-- Price match › Amazon: show and set the minimum price per listing (Brian, Oct 18: "let's also show the minimum price
-- field on a given asin - we should also be able to set that from seller sage"). The minimum / maximum price live in the
-- listing's purchasable_offer (minimum_seller_allowed_price, maximum_seller_allowed_price — Seller Central's "Minimum
-- price" / "Maximum price"; Amazon deactivates the offer when our price falls outside them). pm-amazon action "offers"
-- reads them for our in-stock SKUs each morning into jt.pm_amazon_offers; action "set_price" can now also set the minimum.

create table if not exists jt.pm_amazon_offers (
  sku           text primary key,
  asin          text not null default '',
  product_type  text not null default '',
  our_price     numeric(12,2),
  min_price     numeric(12,2),
  max_price     numeric(12,2),
  error         text not null default '',
  checked_at    timestamptz not null default now()
);

-- the price log also records minimum-price changes: kind price | min | both (new_price = the price after the change)
alter table jt.pm_amazon_price_pushes add column if not exists kind text not null default 'price';
alter table jt.pm_amazon_price_pushes add column if not exists old_min numeric(12,2);
alter table jt.pm_amazon_price_pushes add column if not exists new_min numeric(12,2);

-- SKUs to read: our in-stock listings, not read in the last 20 hours (or the ones asked for), oldest first
create or replace function public.jt_pm_amazon_offer_todo(p jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('sku', x.sku, 'asin', x.asin)) from (
    select s.sku, s.asin from jt.v_pm_amazon_stock s left join jt.pm_amazon_offers o on o.sku = s.sku
    where case when jsonb_typeof(p->'skus') = 'array' then s.sku in (select jsonb_array_elements_text(p->'skus'))
               else o.sku is null or o.checked_at < now() - interval '20 hours' end
    order by o.checked_at nulls first, s.sku
    limit coalesce((p->>'limit')::int, 300)) x), '[]'::jsonb);
end $$;

create or replace function public.jt_pm_amazon_offer_save(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare n int := 0; r jsonb;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  for r in select * from jsonb_array_elements(coalesce(p->'rows', '[]'::jsonb)) loop
    if coalesce(r->>'error', '') <> '' then
      -- a failed read keeps what we knew; only the error and time change
      insert into jt.pm_amazon_offers as o (sku, asin, error, checked_at) values (r->>'sku', coalesce(r->>'asin', ''), left(r->>'error', 500), now())
      on conflict (sku) do update set error = excluded.error, checked_at = now();
    else
      insert into jt.pm_amazon_offers as o (sku, asin, product_type, our_price, min_price, max_price, error, checked_at)
      values (r->>'sku', coalesce(r->>'asin', ''), coalesce(r->>'product_type', ''), nullif(r->>'our_price', '')::numeric,
              nullif(r->>'min_price', '')::numeric, nullif(r->>'max_price', '')::numeric, '', now())
      on conflict (sku) do update set asin = coalesce(nullif(excluded.asin, ''), o.asin), product_type = excluded.product_type,
        our_price = excluded.our_price, min_price = excluded.min_price, max_price = excluded.max_price, error = '', checked_at = now();
    end if;
    n := n + 1;
  end loop;
  return n;
end $$;

create or replace function public.jt_pm_amazon_price_push_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare pid bigint; newp numeric := coalesce(nullif(p->>'new_price', '')::numeric, nullif(p->>'old_price', '')::numeric, 0);
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into jt.pm_amazon_price_pushes (sku, asin, old_price, new_price, status, issues, error, requested_by, kind, old_min, new_min)
  values (p->>'sku', coalesce(p->>'asin', ''), nullif(p->>'old_price', '')::numeric, newp, coalesce(p->>'status', 'failed'),
          coalesce(p->'issues', '[]'::jsonb), left(coalesce(p->>'error', ''), 500), coalesce(p->>'by', ''), coalesce(p->>'kind', 'price'),
          nullif(p->>'old_min', '')::numeric, nullif(p->>'new_min', '')::numeric)
  returning id into pid;
  if p->>'status' = 'ACCEPTED' then
    if coalesce(p->>'kind', 'price') <> 'min' and coalesce(p->>'asin', '') <> '' then
      update jt.pm_amazon_prices set own_price = newp where asin = p->>'asin';
    end if;
    update jt.pm_amazon_offers set our_price = case when coalesce(p->>'kind', 'price') <> 'min' then newp else our_price end,
      min_price = case when p->>'kind' in ('min', 'both') then nullif(p->>'new_min', '')::numeric else min_price end
    where sku = p->>'sku';
  end if;
  return pid;
end $$;

create or replace view jt.v_pm_amazon_last_push as
select distinct on (sku) sku, asin, old_price, new_price, status, error, issues, requested_by, requested_at, kind, old_min, new_min
from jt.pm_amazon_price_pushes order by sku, requested_at desc;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.pm_amazon_offers, jt.v_pm_amazon_last_push to jt_reader;
  end if;
end $$;
