-- 211: Amazon master data at the seller SKU level too (Brian, Nov 4: "we really need to show the SKU info within the ASIN
-- info as we will want to control things at the SKU level in our cleanup. i originally said asin, but we need SKU as
-- well"). Each SKU under its ASIN on Active products › Amazon ASINs gets its own status (same 4 as the ASIN, migration
-- 210) and fulfillment (FBA or FBM). Seller Sage only — nothing is sent to Amazon. Until set, suggested from Amazon:
--   not in the listings any more                    → Closed / deleted
--   Active                                          → Active
--   Inactive, FBA SKU with none sellable at FBA,
--     or FBM SKU with qty 0                         → Inactive – out of stock
--   Inactive otherwise (or Incomplete)              → Inactive – other reasons
-- Fulfillment suggestion = the channel it lists on now (DEFAULT = FBM); for a SKU no longer listed, FBA if Amazon has
-- (or had) it in FBA inventory or charged FBA fees on it, else FBM.

create table if not exists jt.amazon_sku_master (
  sku     text primary key,
  status  text check (status in ('active', 'inactive_oos', 'inactive_other', 'closed')),
  ful     text check (ful in ('FBA', 'FBM')),
  note    text not null default '',
  set_by  text not null default '',
  set_at  timestamptz not null default now()
);
alter table jt.amazon_sku_master enable row level security;

-- p = {skus: [...], status?: active | inactive_oos | inactive_other | closed | '' (back to the suggestion),
--      ful?: 'FBA' | 'FBM' | '' (back to the suggestion), note?}. Only the keys given are changed.
create or replace function jt.amazon_sku_master_set(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  insert into jt.amazon_sku_master (sku, status, ful, note, set_by)
  select trim(x),
         case when p ? 'status' then nullif(p->>'status', '') end,
         case when p ? 'ful' then nullif(upper(p->>'ful'), '') end,
         coalesce(p->>'note', ''), coalesce(p->>'by', '')
  from jsonb_array_elements_text(coalesce(p->'skus', '[]'::jsonb)) x where trim(x) <> ''
  on conflict (sku) do update set
    status = case when p ? 'status' then excluded.status else jt.amazon_sku_master.status end,
    ful    = case when p ? 'ful' then excluded.ful else jt.amazon_sku_master.ful end,
    note   = case when p ? 'note' then excluded.note else jt.amazon_sku_master.note end,
    set_by = excluded.set_by, set_at = now();
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.jt_amazon_sku_master(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare em text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'email', '');
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.amazon_sku_master_set(p || jsonb_build_object('by', em));
end $$;

-- one row per seller SKU: in today's listings, in FBA / AWD inventory with stock, sold in the last 12 months, or set here
create or replace function jt.amazon_skus()
returns table(sku text, asin text, title text, ch text, amz_status text, price numeric, qty integer, opened text, in_listings boolean,
              fba_available integer, fba_inbound integer, awd integer, prep integer,
              sold30 integer, sold90 integer, sold365 integer, last_sold date,
              suggest text, suggest_ful text, status text, ful text, note text, set_by text, set_at timestamptz)
language sql stable security definer set search_path = '' as $$
  with l as (
    select distinct on (x->>0) x->>0 as sku, upper(x->>1) as asin, x->>2 as title, nullif(x->>3, '')::numeric as price, nullif(x->>4, '')::int as qty,
           case when x->>5 = 'DEFAULT' then 'FBM' else 'FBA' end as ch, coalesce(x->>6, '') as st, nullif(x->>7, '') as opened
    from jt.docs d, jsonb_array_elements(d.data->'rows') x
    where d.collection = 'amzlistings' and coalesce(x->>0, '') <> ''
    order by x->>0, (x->>6 = 'Active') desc),
  fi as (select f.sku, nullif(upper(f.asin), '') as asin, nullif(f.name, '') as name,
           f.fulfillable + f.reserved_transfer + f.reserved_processing as avail, f.inbound_working + f.inbound_shipped + f.inbound_receiving as inbound, f.total
         from jt.fba_inventory f),
  aw as (select a.sku, a.available + a.inbound + a.reserved as awd from jt.awd_inventory a where a.active),
  pr as (select i.amazon_sku as sku, sum(i.qty)::int as prep from jt.prep_items i where i.qty > 0 and coalesce(i.amazon_sku, '') <> '' group by 1),
  sold as (select s.sku, sum(s.units) filter (where s.day > current_date - 30)::int as s30, sum(s.units) filter (where s.day > current_date - 90)::int as s90,
             sum(s.units)::int as s365, max(s.day) filter (where s.units > 0) as last, bool_or(coalesce(s.fbafees, 0) <> 0) as fba_fees
           from jt.amazon_sku_daily s where s.day > current_date - 365 group by 1),
  k as (select l.sku from l union select fi.sku from fi where fi.total > 0 union select aw.sku from aw where aw.awd > 0
        union select pr.sku from pr union select sold.sku from sold where sold.s365 > 0 union select m.sku from jt.amazon_sku_master m),
  x as (
    select k.sku, coalesce(l.asin, fi.asin, upper(sa.asin), '') as asin, coalesce(l.title, fi.name, sa.title, '') as title,
           coalesce(l.ch, case when fi.sku is not null or sold.fba_fees then 'FBA' else 'FBM' end) as ch,
           coalesce(l.st, '') as st, l.price, l.qty, l.opened, l.sku is not null as listed,
           coalesce(fi.avail, 0) as avail, coalesce(fi.inbound, 0) as inbound, coalesce(aw.awd, 0) as awd, coalesce(pr.prep, 0) as prep,
           coalesce(sold.s30, 0) as s30, coalesce(sold.s90, 0) as s90, coalesce(sold.s365, 0) as s365, sold.last
    from k left join l using (sku) left join fi using (sku) left join aw using (sku) left join pr using (sku) left join sold using (sku)
           left join jt.v_amz_sku_asin sa on sa.sku = k.sku)
  select x.sku, x.asin, x.title, x.ch, x.st, x.price, x.qty, x.opened, x.listed, x.avail, x.inbound, x.awd, x.prep, x.s30, x.s90, x.s365, x.last,
         case when not x.listed then 'closed' when x.st = 'Active' then 'active'
              when x.st = 'Inactive' and ((x.ch = 'FBA' and x.avail <= 0) or (x.ch = 'FBM' and coalesce(x.qty, 0) <= 0)) then 'inactive_oos'
              else 'inactive_other' end,
         x.ch, m.status, m.ful, coalesce(m.note, ''), coalesce(m.set_by, ''), m.set_at
  from x left join jt.amazon_sku_master m on m.sku = x.sku
$$;

do $$ begin
  execute 'rev' || 'oke all on function jt.amazon_sku_master_set(jsonb) from public';
  execute 'rev' || 'oke all on function public.jt_amazon_sku_master(jsonb) from public, anon';
  execute 'grant execute on function public.jt_amazon_sku_master(jsonb) to authenticated';
  execute 'rev' || 'oke all on function jt.amazon_skus() from public';
  execute 'grant execute on function jt.amazon_skus() to jt_reader';
end $$;
