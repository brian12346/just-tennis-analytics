-- Supabase's API connection runs pg_safeupdate, which refuses a DELETE (or UPDATE) without a WHERE clause, even
-- inside a function. jt.refresh_fifo_costs() (called at the end of "Apply to Shopify") and jt.prep_seed() cleared
-- their tables with a bare DELETE, so Apply to Shopify failed from the dashboard with "DELETE requires a WHERE
-- clause" and nothing was applied. Same functions, with "where true".

create or replace function jt.refresh_fifo_costs() returns integer
language plpgsql security definer set search_path = '' as $$
declare c record; e record; l record; qq numeric[]; qc numeric[]; fq numeric[]; fc numeric[]; fd date[]; fi integer;
        d0 date; need numeric; take numeric; cost numeric; lastc numeric; n integer := 0;
begin
  delete from jt.fifo_sale_costs where true;
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

create or replace function jt.prep_seed(p jsonb) returns integer
language plpgsql security definer set search_path = '' as $$
declare n integer;
begin
  delete from jt.prep_items where true;
  insert into jt.prep_items (variant_id, amazon_sku, qty)
  select (x->>'variant_id')::bigint, coalesce(x->>'amazon_sku', ''), sum((x->>'qty')::integer)
  from jsonb_array_elements(coalesce(p->'lines', '[]'::jsonb)) x
  where (x->>'qty')::integer > 0
  group by 1, 2;
  get diagnostics n = row_count;
  insert into jt.prep_moves (kind, variant_id, amazon_sku, qty_change, qty_after, note, by_user)
  select 'seed', variant_id, amazon_sku, qty, qty, 'starting inventory', coalesce(p->>'by', '') from jt.prep_items;
  return n;
end $$;
