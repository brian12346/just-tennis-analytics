-- Receiving before the invoice (Brian, Oct 29: "we should be able to receive products without an invoice and have it
-- essentially be a mock invoice and then be able to add the invoice later"). Units received on a PO that no invoice
-- counts yet show as a "no invoice yet" card in Received; when an invoice for them is put on the PO later, they count
-- on it. jt.invoice_receipts_sync (migration 040) already did that when receiving; now it also runs when an invoice's
-- lines are saved or an invoice moves onto an order.
create or replace function jt.trg_invoice_lines_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
declare ord bigint;
begin
  for ord in select distinct i.order_id from nt join jt.invoices i on i.id = nt.invoice_id where i.order_id is not null loop
    perform jt.invoice_receipts_sync(ord);
  end loop;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'invoice_lines_sync_ins') then
    create trigger invoice_lines_sync_ins after insert on jt.invoice_lines referencing new table as nt
      for each statement execute function jt.trg_invoice_lines_sync();
  end if;
  if not exists (select 1 from pg_trigger where tgname = 'invoice_lines_sync_upd') then
    create trigger invoice_lines_sync_upd after update on jt.invoice_lines referencing new table as nt
      for each statement execute function jt.trg_invoice_lines_sync();
  end if;
end $$;

create or replace function jt.trg_invoice_order_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.order_id is not null and new.order_id is distinct from old.order_id then perform jt.invoice_receipts_sync(new.order_id); end if;
  return null;
end $$;
do $$ begin
  if not exists (select 1 from pg_trigger where tgname = 'invoice_order_sync') then
    create trigger invoice_order_sync after update of order_id on jt.invoices for each row execute function jt.trg_invoice_order_sync();
  end if;
end $$;
do $$ begin
  execute 'rev' || 'oke all on function jt.trg_invoice_lines_sync() from public';
  execute 'rev' || 'oke all on function jt.trg_invoice_order_sync() from public';
end $$;

-- the "no invoice yet" card has its own place in the Received lane
alter table jt.prep_orders add column if not exists noinv_lane_pos integer;
create or replace function jt.lane_order(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare k text := p->>'kind'; clr boolean := coalesce((p->>'clear')::boolean, false); n integer; m integer; r integer;
begin
  if k not in ('po', 'inv') then raise exception 'kind must be po or inv'; end if;
  if k = 'po' then
    update jt.prep_orders o set lane_pos = case when clr then null else x.n::integer end
    from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n)
    where x.id !~ '^[in]' and o.id = regexp_replace(x.id, '^o', '')::bigint;
    get diagnostics n = row_count;
    update jt.invoices i set po_lane_pos = case when clr then null else x.n::integer end
    from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n)
    where x.id ~ '^i' and i.id = substr(x.id, 2)::bigint;
    get diagnostics m = row_count;
    update jt.prep_orders o set noinv_lane_pos = case when clr then null else x.n::integer end
    from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n)
    where x.id ~ '^n' and o.id = substr(x.id, 2)::bigint;
    get diagnostics r = row_count;
    return n + m + r;
  end if;
  update jt.invoices i set lane_pos = case when clr then null else x.n::integer end
  from jsonb_array_elements_text(coalesce(p->'ids', '[]'::jsonb)) with ordinality x(id, n) where i.id = x.id::bigint;
  get diagnostics n = row_count;
  return n;
end $$;
do $$ begin execute 'rev' || 'oke all on function jt.lane_order(jsonb) from public'; end $$;

-- invoices already on POs pick up what was received before them (on Oct 29 this was 2 units, Yonex PO1038)
do $$ declare o bigint; begin for o in select distinct order_id from jt.invoices where order_id is not null loop perform jt.invoice_receipts_sync(o); end loop; end $$;
