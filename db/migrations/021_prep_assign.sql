-- Assigning prep-center stock to an Amazon listing later. Stock can come in for "any listing" (a product sold on
-- several ASINs, e.g. a single and a 2-pack) and be earmarked for one listing when you know which it'll go out as,
-- or moved between listings / back to "any". Units are Shopify units; a 2-pack listing takes 2 per Amazon unit.
-- Each assignment is two moves of kind 'assign' (out of one row, into the other); the total doesn't change.

alter table jt.prep_moves drop constraint if exists prep_moves_kind_check;
alter table jt.prep_moves add constraint prep_moves_kind_check check (kind in ('seed', 'adjust', 'ship', 'receive', 'unship', 'unreceive', 'assign'));

-- p = {variant_id, from_sku ('' = any listing), moves: [{to_sku ('' = any listing), qty}], note, by}. Returns units moved.
create or replace function jt.prep_assign(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare vid bigint := (p->>'variant_id')::bigint; src text := coalesce(p->>'from_sku', ''); x jsonb; q integer; dst text;
  have integer; total integer := 0; after integer;
begin
  select qty into have from jt.prep_items where variant_id = vid and amazon_sku = src for update;
  for x in select * from jsonb_array_elements(coalesce(p->'moves', '[]'::jsonb)) loop
    q := coalesce((x->>'qty')::integer, 0); dst := coalesce(x->>'to_sku', '');
    if q < 0 then raise exception 'quantities must be 0 or more'; end if;
    if q = 0 or dst = src then continue; end if;
    total := total + q;
    if coalesce(have, 0) < total then
      raise exception 'only % in the prep center for variant % %, can''t assign %', coalesce(have, 0), vid, coalesce(nullif(src, ''), '(any listing)'), total;
    end if;
    update jt.prep_items set qty = qty - q, updated_at = now() where variant_id = vid and amazon_sku = src returning qty into after;
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user)
    values ('assign', vid, src, -q, after, 'to ' || coalesce(nullif(dst, ''), 'any listing') || coalesce(nullif(' · ' || (p->>'note'), ' · '), ''), coalesce(p->>'by', ''));
    insert into jt.prep_items (variant_id, amazon_sku, qty) values (vid, dst, q)
    on conflict (variant_id, amazon_sku) do update set qty = jt.prep_items.qty + excluded.qty, updated_at = now()
    returning qty into after;
    insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user)
    values ('assign', vid, dst, q, after, 'from ' || coalesce(nullif(src, ''), 'any listing') || coalesce(nullif(' · ' || (p->>'note'), ' · '), ''), coalesce(p->>'by', ''));
  end loop;
  delete from jt.prep_items where qty = 0;
  return total;
end $$;
revoke all on function jt.prep_assign(jsonb) from public;

create or replace function public.jt_prep_assign(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_assign(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_assign(jsonb) from public, anon;
grant execute on function public.jt_prep_assign(jsonb) to authenticated;
