-- Sales costed by cost layer (FIFO), and applying PO costs only after the PO is received in Shopify.
--
-- For a product with cost layers (028):
--   - A sale before the layers started is costed at the opening layer's cost, which is the cost the product had then.
--     Otherwise re-costing past sales at today's Shopify cost would move them to the new average.
--   - Sales from then on take units from the layers oldest first: the opening stock, then each PO receipt at its
--     PO cost.
--   - Amazon sales (the monthly summaries, through the Shopify mappings) take units too, dated mid-month, so a
--     product sold on both channels uses up its layers at the right pace. Only Shopify sales rows get a cost here.
--   - A return puts its units back at the cost they last went out at. Units sold beyond every layer are costed at
--     the last cost.
-- jt.fifo_sale_costs holds the result. jt.refresh_fifo_costs() rebuilds it; the hourly and nightly syncs and
-- "Apply to Shopify" call it. jt.v_shopify_sales_costed uses it, and so, through that view, do the daily totals and
-- the Product sales tab. Products without layers are costed as before (today's Shopify cost).
--
-- Received in Shopify: shopify_received_at on the PO is set by hand ("Received in Shopify"), and marking it starts a
-- catalog sync. Apply to Shopify is refused for a PO with received Shopify-store products until then, and until
-- Shopify's stock has synced after it. That way the average cost uses stock counts that include the new units.

alter table jt.prep_orders add column if not exists shopify_received_at timestamptz;
alter table jt.prep_orders add column if not exists shopify_received_by text not null default '';

create table if not exists jt.fifo_sale_costs (
  day date not null,
  order_id bigint not null,
  variant_id bigint not null,
  units numeric(12,2) not null,
  cogs numeric(14,4) not null,
  primary key (day, order_id, variant_id)
);

create or replace function jt.refresh_fifo_costs() returns integer
language plpgsql security definer set search_path = '' as $$
declare c record; e record; l record; qq numeric[]; qc numeric[]; fq numeric[]; fc numeric[]; fd date[]; fi integer;
        d0 date; need numeric; take numeric; cost numeric; lastc numeric; n integer := 0;
begin
  delete from jt.fifo_sale_costs;
  for c in select * from jt.cost_layers loop
    d0 := (c.created_at at time zone 'America/Los_Angeles')::date;
    -- before the layers: the cost the product had then
    insert into jt.fifo_sale_costs (day, order_id, variant_id, units, cogs)
    select s.day, s.order_id, s.variant_id, sum(s.units), sum(s.units) * c.unit_cost
    from jt.shopify_sales s where s.variant_id = c.variant_id and s.day < d0 group by 1, 2, 3;
    -- on hand when the layers started: the opening stock, then PO receipts already in
    qq := array[c.qty::numeric]; qc := array[c.unit_cost]; lastc := c.unit_cost;
    for l in select qty, unit_cost from jt.v_cost_layers where variant_id = c.variant_id and kind = 'po' and at < c.created_at order by at loop
      qq := qq || l.qty::numeric; qc := qc || l.unit_cost;
    end loop;
    -- receipts still to come
    fq := '{}'; fc := '{}'; fd := '{}'; fi := 1;
    for l in select qty, unit_cost, (at at time zone 'America/Los_Angeles')::date as d from jt.v_cost_layers
             where variant_id = c.variant_id and kind = 'po' and at >= c.created_at order by at loop
      fq := fq || l.qty::numeric; fc := fc || l.unit_cost; fd := fd || l.d;
    end loop;
    for e in
      select s.day, s.order_id, sum(s.units) as units, true as shop from jt.shopify_sales s
      where s.variant_id = c.variant_id and s.day >= d0 group by 1, 2
      union all
      select make_date(split_part(m.id, '-', 1)::integer, split_part(m.id, '-', 2)::integer, 15), -1,
             sum(coalesce((m.data->'skus'->mp.sku->>0)::numeric, 0) * mp.units), false
      from jt.docs m
      join (select d.data->>'sku' as sku, coalesce(nullif(d.data->>'units', '')::numeric, 1) as units from jt.docs d
            where d.collection = 'amzmap' and d.data->>'kind' = 'shopify'
              and (regexp_match(d.data->>'variantId', '(\d+)$'))[1]::bigint = c.variant_id) mp on m.data->'skus' ? mp.sku
      where m.collection = 'amzmonths' and m.id ~ '^\d{4}-\d{2}$'
        and make_date(split_part(m.id, '-', 1)::integer, split_part(m.id, '-', 2)::integer, 15) >= d0
      group by 1
      order by 1, 4 desc, 2
    loop
      while fi <= coalesce(array_length(fd, 1), 0) and fd[fi] <= e.day loop
        qq := qq || fq[fi]; qc := qc || fc[fi]; fi := fi + 1;
      end loop;
      need := e.units; cost := 0;
      if need > 0 then
        while need > 0 loop
          if coalesce(array_length(qq, 1), 0) = 0 then cost := cost + need * lastc; need := 0; exit; end if;
          take := least(need, qq[1]); cost := cost + take * qc[1]; lastc := qc[1]; qq[1] := qq[1] - take; need := need - take;
          if qq[1] <= 0 then qq := qq[2:array_upper(qq, 1)]; qc := qc[2:array_upper(qc, 1)]; end if;
        end loop;
      elsif need < 0 then
        qq := array[-need] || qq; qc := array[lastc] || qc; cost := need * lastc;
      end if;
      if e.shop then
        insert into jt.fifo_sale_costs (day, order_id, variant_id, units, cogs) values (e.day, e.order_id, c.variant_id, e.units, cost);
        n := n + 1;
      end if;
    end loop;
  end loop;
  return n;
end $$;
revoke all on function jt.refresh_fifo_costs() from public;

-- the re-costed Shopify sales: FIFO where a product has layers, else today's cost (010)
create or replace view jt.v_shopify_sales_costed as
select s.day, s.order_id, s.order_name, s.variant_id, s.product_id, s.product_title, s.variant_title, s.sku,
       s.product_type, s.vendor, s.sales_channel, s.units, s.gross, s.discounts, s.returns, s.net,
       case when f.order_id is not null and s.variant_id <> 0 then case when f.units = 0 then 0 else round(f.cogs * s.units / f.units, 2) end
            when v.unit_cost is not null and s.variant_id <> 0 then round(s.units * v.unit_cost, 2) else s.cogs end as cogs,
       case when (f.order_id is not null or v.unit_cost is not null) and s.variant_id <> 0 then 0 else s.net_no_cost end as net_no_cost,
       s.synced_at,
       s.cogs as cogs_recorded, s.net_no_cost as net_no_cost_recorded
from jt.shopify_sales s
left join jt.variants v on v.variant_id = s.variant_id
left join jt.fifo_sale_costs f on f.day = s.day and f.order_id = s.order_id and f.variant_id = s.variant_id;

-- Marking a PO received in Shopify (on = false clears it). Starts a catalog sync so Shopify's stock counts catch up.
create or replace function jt.po_shopify_received(p jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'id')::bigint; t timestamptz;
begin
  if coalesce((p->>'on')::boolean, true) then
    update jt.prep_orders set shopify_received_at = now(), shopify_received_by = coalesce(p->>'by', ''), updated_at = now() where id = ord returning shopify_received_at into t;
    if t is null then raise exception 'order % not found', ord; end if;
    if to_regprocedure('jt.dispatch_sync(text)') is not null then perform jt.dispatch_sync('catalog'); end if;
  else
    update jt.prep_orders set shopify_received_at = null, shopify_received_by = '', updated_at = now() where id = ord;
  end if;
  return t;
end $$;
revoke all on function jt.po_shopify_received(jsonb) from public;

create or replace function public.jt_po_shopify_received(p jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
begin
  if not jt.is_app_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  return jt.po_shopify_received(p || jsonb_build_object('by', coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', '')));
end $$;
revoke all on function public.jt_po_shopify_received(jsonb) from public, anon;
grant execute on function public.jt_po_shopify_received(jsonb) to authenticated;

create or replace function jt.po_apply_costs(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare ord bigint := (p->>'order_id')::bigint; x jsonb; n integer; o record;
begin
  select * into o from jt.prep_orders where id = ord;
  if o.id is null then raise exception 'order % not found', ord; end if;
  -- the PO's Shopify-store products have to be received in Shopify first (so Shopify's stock count includes them)
  if exists (select 1 from jt.prep_order_lines where order_id = ord and dest = 'shopify' and qty_received > 0) then
    if o.shopify_received_at is null then raise exception 'mark the PO received in Shopify first'; end if;
    if coalesce((select max(seen_at) from jt.variants), '-infinity') < o.shopify_received_at then
      raise exception 'waiting for Shopify''s stock to sync after the PO was received there';
    end if;
  end if;
  for x in select * from jsonb_array_elements(coalesce(p->'items', '[]'::jsonb)) loop
    if not exists (select 1 from jt.prep_order_lines where order_id = ord and variant_id = (x->>'variant_id')::bigint and qty_received > 0) then
      raise exception 'variant % hasn''t been received on this order', x->>'variant_id';
    end if;
    if nullif(x->>'cost', '') is null or (x->>'cost')::numeric < 0 then raise exception 'a cost is needed for variant %', x->>'variant_id'; end if;
    if jsonb_typeof(x->'opening') = 'object' then
      insert into jt.cost_layers (variant_id, qty, unit_cost, at, order_id, created_by)
      values ((x->>'variant_id')::bigint, greatest(0, coalesce((x->'opening'->>'qty')::integer, 0)), (x->'opening'->>'unit_cost')::numeric,
              (x->'opening'->>'at')::timestamptz, ord, coalesce(p->>'by', ''))
      on conflict (variant_id) do nothing;
    end if;
    update jt.prep_order_lines set cost_applied = (x->>'cost')::numeric, cost_applied_at = now(), update_cost = false
    where order_id = ord and variant_id = (x->>'variant_id')::bigint;
  end loop;
  n := jt.queue_cost_updates(coalesce((select jsonb_agg(jsonb_build_object('variant_id', (e->>'variant_id')::bigint, 'cost', (e->>'cost')::numeric))
                                        from jsonb_array_elements(p->'items') e), '[]'::jsonb));
  perform jt.refresh_fifo_costs();
  return n;
end $$;
revoke all on function jt.po_apply_costs(jsonb) from public;
