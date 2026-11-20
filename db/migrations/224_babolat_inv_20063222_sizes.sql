-- One-off data fix (Nov 20, Brian): Babolat invoice 20063222 (jt.invoices 103) bills several sizes on one line ("PA 98 GEN9 U -
-- sizes 2 x12, 3 x16"), so each line was matched to one size and PO 72 looked short. Split those lines into one line per
-- size, matched to PO 72's products; also fix lines matched to the wrong size/colour (Propulse Storm, Jet Mach 3 Jr,
-- Propulse Jr Yellow / Evening Sand / Dark Purple kids sizes, Court Backpack Hero black). The original lines are kept in
-- jt.docs (invoice_line_backup / 103-before-size-split). Runs only if the invoice is still the untouched 32-line draft.
do $$
declare ok boolean;
begin
  select count(*) = 32 and bool_or(line_no = 4 and qty = 28) and (select status = 'draft' from jt.invoices where id = 103)
    into ok from jt.invoice_lines where invoice_id = 103;
  if not coalesce(ok, false) then raise notice 'invoice 103 changed since Nov 20 — size split skipped'; return; end if;

  insert into jt.docs (collection, id, data, updated_at)
  select 'invoice_line_backup', '103-before-size-split', jsonb_build_object('invoice_id', 103, 'lines', jsonb_agg(to_jsonb(l) order by l.line_no)), now()
  from jt.invoice_lines l where l.invoice_id = 103
  on conflict (collection, id) do nothing;

  create temp table m224(old_line int, sub int, size_label text, qty numeric, vid bigint) on commit drop;
  insert into m224 values
   (4,1,'2',12,50847786729757),(4,2,'3',16,50847786762525),
   (6,1,'1',1,50847773786397),(6,2,'2',25,50847773819165),(6,3,'3',2,50847773851933),
   (7,1,'2',5,50847803834653),(7,2,'3',7,50847803867421),
   (8,1,'0',1,50847774998813),(8,2,'1',13,50847775031581),(8,3,'2',6,50847775064349),
   (11,1,'0',5,50956760809757),(11,2,'1',7,50956760842525),(11,3,'2',5,50956760875293),
   (16,1,'8.5',1,52571438612765),(16,2,'12',1,52571438842141),
   (17,1,'8.5',5,52571237253405),(17,2,'9',1,52571237286173),(17,3,'11.5',1,52571237450013),
   (18,1,'4',1,52575348949277),(18,2,'5',1,52575349014813),
   (19,1,'4.5',1,52576015515933),
   (20,1,'4.5',1,52576094880029),(20,2,'5',1,52576094912797),(20,3,'6',1,52576094978333),
   (21,1,'1',1,52576094650653),(21,2,'3',1,52576094781725),
   (22,1,'4.5',2,49584972824861),
   (23,1,'13.5',2,49584972562717),(23,2,'1',2,49584972595485),
   (29,0,null,3,50278598803741);

  create temp table nl224 on commit drop as
  select row_number() over (order by s.line_no, coalesce(m.sub, 0))::int as line_no, s.item_code, s.upc,
    case when m.size_label is null then s.description else regexp_replace(s.description, '\s*-\s*sizes?\s.*$', '') || ' - size ' || m.size_label end as description,
    coalesce(m.qty, s.qty) as qty, s.unit_cost, round(coalesce(m.qty, s.qty) * s.unit_cost, 2) as amount,
    coalesce(m.vid, s.variant_id) as variant_id, case when m.vid is not null then 'manual' else s.match_how end as match_how,
    s.update_cost, s.new_price, s.dest, s.amazon_sku, s.account, s.vendor_no
  from jt.invoice_lines s left join m224 m on m.old_line = s.line_no where s.invoice_id = 103;

  delete from jt.invoice_lines where invoice_id = 103;
  insert into jt.invoice_lines (invoice_id, line_no, item_code, upc, description, qty, unit_cost, amount, variant_id, match_how, update_cost, new_price, dest, amazon_sku, account, vendor_no)
  select 103, line_no, item_code, upc, description, qty, unit_cost, amount, variant_id, match_how, update_cost, new_price, dest, amazon_sku, account, vendor_no from nl224;
end $$;
