-- Finance › Payables: "Payment submitted" (Brian, Oct 12) — a bill whose payment has been sent but isn't paid in
-- QuickBooks yet (a check in the mail, an ACH waiting to clear, a card payment pending). Marked on Payables; the page
-- shows it until QuickBooks has the bill paid (the row stays here, harmless, once the bill's balance is 0).
create table if not exists fin.bill_submitted (
  bill_id text primary key,
  submitted_on date not null default ((now() at time zone 'America/Los_Angeles')::date),
  note text not null default '',
  submitted_by text not null default '',
  submitted_at timestamptz not null default now()
);

-- p: {bill_ids: [...], submitted_on?, note?, clear?: true}
create or replace function public.fin_bill_submitted_set(p jsonb) returns int
language plpgsql security definer set search_path = '' as $$
declare who text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::json ->> 'email', ''); n int;
begin
  if not fin.is_user() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce((p->>'clear')::boolean, false) then
    delete from fin.bill_submitted where bill_id in (select jsonb_array_elements_text(p->'bill_ids'));
    get diagnostics n = row_count; return n;
  end if;
  insert into fin.bill_submitted (bill_id, submitted_on, note, submitted_by)
  select b, coalesce(nullif(p->>'submitted_on', '')::date, (now() at time zone 'America/Los_Angeles')::date), coalesce(p->>'note', ''), who
  from jsonb_array_elements_text(p->'bill_ids') b
  on conflict (bill_id) do update set submitted_on = excluded.submitted_on, note = excluded.note, submitted_by = excluded.submitted_by, submitted_at = now();
  get diagnostics n = row_count; return n;
end $$;

grant select on fin.bill_submitted to fin_reader;
revoke all on function public.fin_bill_submitted_set(jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke all on function public.fin_bill_submitted_set(jsonb) from anon;
    grant execute on function public.fin_bill_submitted_set(jsonb) to authenticated;
  end if;
end $$;
