-- Price match › Amazon: set our price on Amazon from the page (Brian, Oct 18: "i don't see a way to set price on amazon
-- when i want to change my price"). The pm-amazon edge function's "set_price" action patches the listing's
-- purchasable_offer (Listings Items API, our_price for amazon.com; the minimum/maximum price rules set in Seller Central
-- are kept and checked first) and logs every request here.
create table if not exists jt.pm_amazon_price_pushes (
  id            bigserial primary key,
  sku           text not null,
  asin          text not null default '',
  old_price     numeric(12,2),
  new_price     numeric(12,2) not null,
  status        text not null default 'failed',     -- ACCEPTED | INVALID | failed
  issues        jsonb not null default '[]'::jsonb,
  error         text not null default '',
  requested_by  text not null default '',
  requested_at  timestamptz not null default now()
);
create index if not exists pm_amazon_price_pushes_sku on jt.pm_amazon_price_pushes (sku, requested_at desc);

create or replace function public.jt_pm_amazon_price_push_save(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare pid bigint;
begin
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'role', current_user) not in ('service_role', 'postgres') then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into jt.pm_amazon_price_pushes (sku, asin, old_price, new_price, status, issues, error, requested_by)
  values (p->>'sku', coalesce(p->>'asin', ''), nullif(p->>'old_price', '')::numeric, (p->>'new_price')::numeric, coalesce(p->>'status', 'failed'),
          coalesce(p->'issues', '[]'::jsonb), left(coalesce(p->>'error', ''), 500), coalesce(p->>'by', ''))
  returning id into pid;
  -- shown on the page right away (Amazon takes a few minutes to apply it; the next morning's check confirms it)
  if p->>'status' = 'ACCEPTED' and coalesce(p->>'asin', '') <> '' then
    update jt.pm_amazon_prices set own_price = (p->>'new_price')::numeric where asin = p->>'asin';
  end if;
  return pid;
end $$;

-- the page reads the pending/last change per listing
create or replace view jt.v_pm_amazon_last_push as
select distinct on (sku) sku, asin, old_price, new_price, status, error, issues, requested_by, requested_at
from jt.pm_amazon_price_pushes order by sku, requested_at desc;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then
    grant select on jt.pm_amazon_price_pushes, jt.v_pm_amazon_last_push to jt_reader;
  end if;
end $$;
