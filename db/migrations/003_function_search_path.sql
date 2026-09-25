-- Pin search_path on jt functions (Supabase security advisor 0011). All references are schema-qualified.
alter function jt.variant_cost_on(bigint, date) set search_path = '';
alter function jt.save_cost_override(jsonb) set search_path = '';
alter function jt.delete_cost_override(bigint) set search_path = '';
alter function jt.save_amazon_map(jsonb) set search_path = '';
alter function jt.delete_amazon_map(text) set search_path = '';
alter function jt.set_cost_change_kind(bigint, text) set search_path = '';
alter function jt.set_setting(text, jsonb) set search_path = '';
