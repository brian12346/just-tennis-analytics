-- Veeqo shipping labels (sync job veeqo, also hourly 3 days / nightly 14 days; sync/veeqo.py). Amazon FBM orders are
-- mostly shipped with labels bought in Veeqo. One row per shipment; cost is what Veeqo charged for the label (only for
-- labels bought with Veeqo's rates). amazon_order_id is set when the Veeqo order came from Amazon. No customer details.
create table if not exists jt.veeqo_shipments (
  shipment_id      bigint primary key,
  order_id         bigint not null default 0,
  order_number     text not null default '',
  channel          text not null default '',
  channel_type     text not null default '',
  amazon_order_id  text not null default '',
  tracking         text not null default '',
  carrier          text not null default '',
  service          text not null default '',
  cost             numeric(12,2),
  currency         text not null default '',
  weight           numeric(12,3),
  shipped_at       timestamptz,
  created_at       timestamptz,
  order_created_at timestamptz,
  synced_at        timestamptz not null default now()
);
create index if not exists veeqo_shipments_amazon on jt.veeqo_shipments (amazon_order_id) where amazon_order_id <> '';
create index if not exists veeqo_shipments_shipped on jt.veeqo_shipments (shipped_at);

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'jt_reader') then grant select on jt.veeqo_shipments to jt_reader; end if;
  if exists (select 1 from pg_roles where rolname = 'fin_reader') then grant select on jt.veeqo_shipments to fin_reader; end if;
end $$;
