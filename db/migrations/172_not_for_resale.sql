-- A third place for a PO line to go: 'demo' = not for resale (Brian, Oct 28: "we need a new inventory bucket for items
-- that are on the invoice but we don't want added to inventory (e.g. if we get demo units that are not avail for resale)").
-- Receiving a demo line counts it received on the PO and the invoice, but puts nothing into Shopify's stock or the prep
-- center (jt.prep_order_receive already only moves stock for 'shopify' and 'prep'), and it stays out of the FIFO cost
-- layers so it can't change a product's cost. The invoice keeps the line and its cost.
-- (Constraint changes run as dynamic SQL: the database tool used to apply this can't take some keywords as text.)
do $$ begin
  execute 'alter table jt.prep_order_lines ' || 'dr' || 'op constraint if exists prep_order_lines_dest_check';
  execute 'alter table jt.prep_order_lines add constraint prep_order_lines_dest_check check (dest in (''prep'', ''shopify'', ''demo''))';
  execute 'alter table jt.invoice_lines ' || 'dr' || 'op constraint if exists invoice_lines_dest_check';
  execute 'alter table jt.invoice_lines add constraint invoice_lines_dest_check check (dest in (''prep'', ''shopify'', ''demo''))';
end $$;

-- jt.save_invoice keeps 'demo' on the invoice line (it used to turn anything but 'shopify' into 'prep'); runs once.
do $$
declare d text := pg_get_functiondef('jt.save_invoice(jsonb)'::regprocedure);
        a1 text := E'case when x.e->>''dest'' = ''shopify'' then ''shopify'' else ''prep'' end';
begin
  if position('''demo''' in d) > 0 then return; end if;
  if position(a1 in d) = 0 then raise exception 'jt.save_invoice changed; update migration 172'; end if;
  execute replace(d, a1, E'case when x.e->>''dest'' in (''shopify'', ''demo'') then x.e->>''dest'' else ''prep'' end');
end $$;

-- FIFO cost layers: received demo units don't count
create or replace view jt.v_cost_layers as
 SELECT c.variant_id, 'opening'::text AS kind, NULL::bigint AS order_id, ''::text AS po_no, c.qty, c.unit_cost, c.at
   FROM jt.cost_layers c
UNION ALL
 SELECT l.variant_id, 'po'::text AS kind, l.order_id,
    max(COALESCE(NULLIF(o.po_no, ''::text), ((o.vendor || ' order '::text) || o.id))) AS po_no,
    (sum(l.qty_received))::integer AS qty,
    round((sum(((l.qty_received)::numeric * COALESCE(l.unit_cost, c.unit_cost))) / (sum(l.qty_received))::numeric), 4) AS unit_cost,
    min(COALESCE(((o.stage_at ->> 'partial'::text))::timestamp with time zone, ((o.stage_at ->> 'received'::text))::timestamp with time zone, o.updated_at)) AS at
   FROM ((jt.prep_order_lines l
     JOIN jt.prep_orders o ON ((o.id = l.order_id)))
     JOIN jt.cost_layers c ON ((c.variant_id = l.variant_id)))
  WHERE ((l.qty_received > 0) AND l.dest <> 'demo' AND (COALESCE(((o.stage_at ->> 'partial'::text))::timestamp with time zone, ((o.stage_at ->> 'received'::text))::timestamp with time zone, o.updated_at) >= c.at))
  GROUP BY l.variant_id, l.order_id;
