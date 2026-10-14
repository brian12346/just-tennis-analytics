-- Dealer-portal pulls (Brian, Oct 14: Wilson, Babolat, Head and Yonex portals → full catalogs into Seller Sage).
-- Claude reads a vendor portal in Brian's Chrome and the page sends the rows here through a one-time upload slot:
-- jt.portal_tokens holds a random token Claude makes for the pull (good for 2 hours); public.jt_portal_stage (callable
-- with the public key) only accepts rows with a live token, into jt.portal_stage. Nothing else is touched: Claude then
-- matches the staged rows to products and saves them as the vendor's pricelist (jt.price_list_save, source 'portal').
create table if not exists jt.portal_tokens (
  token       text primary key,
  vendor      text not null,
  expires_at  timestamptz not null default now() + interval '2 hours',
  created_at  timestamptz not null default now()
);
create table if not exists jt.portal_stage (
  id          bigserial primary key,
  token       text not null,
  vendor      text not null,
  part        integer not null default 0,
  rows        jsonb not null,
  n           integer not null default 0,
  staged_at   timestamptz not null default now()
);

create or replace function public.jt_portal_stage(p_token text, p_part integer, p_rows jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare v text; n int;
begin
  select t.vendor into v from jt.portal_tokens t where t.token = p_token and t.expires_at > now();
  if v is null then raise exception 'upload slot closed' using errcode = '42501'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'rows must be a list'; end if;
  n := jsonb_array_length(p_rows);
  if n > 5000 or length(p_rows::text) > 3000000 then raise exception 'too many rows in one part'; end if;
  if (select count(*) from jt.portal_stage s where s.token = p_token) >= 200 then raise exception 'too many parts'; end if;
  insert into jt.portal_stage (token, vendor, part, rows, n) values (p_token, v, coalesce(p_part, 0), p_rows, n);
  return n;
end $$;
revoke all on function public.jt_portal_stage(text, integer, jsonb) from public;
grant execute on function public.jt_portal_stage(text, integer, jsonb) to anon, authenticated;
