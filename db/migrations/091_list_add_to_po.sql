-- On The List, take 2 (Brian, Oct 6): adding to the list doesn't put a product on a PO any more (089 did). Each list
-- row has "Add to PO", which puts it on its vendor's newest draft PO (or a new one) with no quantity required; once
-- on a PO it leaves the "To order" list.

create or replace function jt.prep_list_add(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare lid bigint; vid bigint := (p->>'variant_id')::bigint; sku text := coalesce(p->>'amazon_sku', ''); d text := coalesce(nullif(p->>'dest', ''), 'prep');
begin
  if not exists (select 1 from jt.variants v where v.variant_id = vid) then raise exception 'unknown Shopify variant %', vid; end if;
  select id into lid from jt.prep_list where variant_id = vid and amazon_sku = sku and dest = d and closed_at is null for update;
  if lid is null then
    insert into jt.prep_list (variant_id, amazon_sku, dest, qty, note, source, added_by)
    values (vid, sku, d, nullif(p->>'qty', '')::integer, coalesce(p->>'note', ''), coalesce(p->>'source', ''), coalesce(p->>'by', '')) returning id into lid;
  else
    update jt.prep_list set qty = case when p ? 'qty' then nullif(p->>'qty', '')::integer else qty end, note = coalesce(p->>'note', note) where id = lid;
    update jt.prep_order_lines l set qty_ordered = coalesce(i.qty, l.qty_ordered)
    from jt.prep_list i join jt.prep_orders o on o.id = i.order_id
    where i.id = lid and o.status = 'draft' and l.order_id = o.id and l.variant_id = i.variant_id and l.amazon_sku = i.amazon_sku and l.dest = i.dest;
  end if;
  return lid;
end $$;
revoke all on function jt.prep_list_add(jsonb) from public;

-- p = {id, by}: put one list item on its vendor's draft PO. Returns the order id.
create or replace function jt.prep_list_to_po(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare i record; ven text;
begin
  select * into i from jt.prep_list where id = (p->>'id')::bigint and closed_at is null;
  if i.id is null then raise exception 'that item isn''t on the list'; end if;
  select coalesce(vendor, '') into ven from jt.variants where variant_id = i.variant_id;
  return jt.prep_list_assign(jsonb_build_object('ids', jsonb_build_array(i.id), 'order_id', jt.vendor_draft_order(ven, p->>'by'), 'by', coalesce(p->>'by', '')));
end $$;
revoke all on function jt.prep_list_to_po(jsonb) from public;

create or replace function public.jt_prep_list_to_po(p jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.prep_list_to_po(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_prep_list_to_po(jsonb) from public, anon;
grant execute on function public.jt_prep_list_to_po(jsonb) to authenticated;
