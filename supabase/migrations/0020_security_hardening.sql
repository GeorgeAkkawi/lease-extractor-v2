-- 0020_security_hardening.sql
-- Defense-in-depth hardening, merged from a parallel security pass. Everything
-- here is additive and safe to run on the live project: constraints are generous
-- enough not to reject existing valid data, and new objects fail closed.
--
-- Covers:
--   1) Lock down the SECURITY DEFINER renewal job (search_path pin + revoke EXECUTE)
--   2) Server-side input validation as CHECK constraints (length / type / range)
--   3) Storage bucket: restrict file types + size (unsafe-upload protection)
--   4) (Rate limiting lives in 0018_ai_rate_limit.sql + 0019_ai_rate_limit_anon_block.sql)
--   5) Security/audit event log (auth attempts, API errors, anomalies)

-- ===========================================================================
-- 1) Harden the SECURITY DEFINER renewal job
-- ---------------------------------------------------------------------------
-- A SECURITY DEFINER function with an unpinned search_path can be hijacked by a
-- malicious schema/object on the caller's search_path. Pin it to empty and
-- schema-qualify every reference. Also revoke EXECUTE from the API roles so a
-- logged-in user can't invoke it over RPC to force renewals across the system —
-- only the scheduler (pg_cron / service role / postgres) may run it.
-- ===========================================================================
create or replace function public.apply_due_renewals()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  r record;
  v_new_start date;
  v_new_end date;
  v_old_rent numeric;
  v_new_rent numeric;
  v_prop record;
  v_count integer := 0;
begin
  for l in
    select * from public.leases
    where lease_termination_date is not null
      and lease_termination_date <= current_date
  loop
    select * into r
      from public.renewal_options
     where lease_id = l.id and status = 'pending'
     order by notice_by_date nulls last
     limit 1;
    if not found then
      continue;
    end if;

    select * into v_prop from public.properties where id = l.property_id;

    v_new_start := l.lease_termination_date;
    v_new_end   := l.lease_termination_date + make_interval(months => coalesce(r.term_months, 12));
    v_old_rent  := coalesce(l.base_rent, 0);
    v_new_rent  := coalesce(r.new_rent, v_old_rent);

    insert into public.expired_leases (owner_id, property_id, tenant_name, sf, base_rent, lease_start, lease_end, status, note)
    values (l.owner_id, l.property_id, l.tenant_name, l.square_footage, v_old_rent, l.lease_start, l.lease_termination_date,
            'Renewed', 'Auto-renewed (' || coalesce(r.option_label, 'renewal option') || ') — new term through ' || v_new_end);

    update public.leases
       set lease_start = v_new_start,
           lease_termination_date = v_new_end,
           base_rent = v_new_rent
     where id = l.id;

    update public.renewal_options set status = 'applied', applied_at = now() where id = r.id;

    insert into public.notifications (owner_id, lease_id, property_id, corporation_id, kind, title, body, email_subject, email_body, read)
    values (
      l.owner_id, l.id, l.property_id, v_prop.corporation_id, 'renewal_applied',
      'Lease renewed — ' || l.tenant_name,
      'Term extended to ' || v_new_end || ' · base rent now ' || to_char(v_new_rent, 'FM$999,999,999'),
      'Lease renewal — ' || coalesce(v_prop.name, 'your space') || ' (effective ' || to_char(v_new_start, 'FMMonth FMDD, YYYY') || ')',
      'Dear ' || l.tenant_name || E',\n\nThis note confirms that your lease has renewed. The new term runs ' ||
        to_char(v_new_start, 'FMMonth FMDD, YYYY') || ' through ' || to_char(v_new_end, 'FMMonth FMDD, YYYY') ||
        '. Your new annual base rent is ' || to_char(v_new_rent, 'FM$999,999,999') ||
        E'. Please update your records and remit the new amount beginning with the renewed term.\n\nThank you,\nProperty Management',
      false
    );

    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

-- Only the scheduler/service role may run the job — not anon or logged-in users.
revoke all on function public.apply_due_renewals() from public, anon, authenticated;

-- ===========================================================================
-- 2) Server-side input validation (CHECK constraints)
-- ---------------------------------------------------------------------------
-- "Reject invalid data and enforce strict input types" at the strongest layer:
-- the database. These run regardless of which client wrote the row (web, RPC,
-- or a future integration). Bounds are generous so legitimate existing data
-- passes; they exist to stop absurd/abusive payloads (giant blobs, negatives).
-- Added with NOT VALID first so the migration never fails on legacy rows, then
-- validated; if a legacy row violates a bound, VALIDATE surfaces it explicitly
-- rather than silently skipping enforcement.
-- ===========================================================================
do $$
declare
  c record;
begin
  for c in
    select * from (values
      -- table,            constraint name,                 check expression
      ('corporations',     'ck_corp_name_len',              'char_length(name) between 1 and 200'),
      ('corporations',     'ck_corp_address_len',           'address is null or char_length(address) <= 500'),
      ('properties',       'ck_prop_name_len',              'char_length(name) between 1 and 200'),
      ('properties',       'ck_prop_address_len',           'address is null or char_length(address) <= 500'),
      ('properties',       'ck_prop_building_sf',           'building_sf is null or (building_sf >= 0 and building_sf < 1e12)'),
      ('leases',           'ck_lease_tenant_len',           'char_length(tenant_name) between 1 and 200'),
      ('leases',           'ck_lease_sf',                   'square_footage is null or (square_footage >= 0 and square_footage < 1e12)'),
      ('leases',           'ck_lease_rent',                 'base_rent is null or (base_rent >= 0 and base_rent < 1e12)'),
      ('leases',           'ck_lease_terms_len',            'lease_terms is null or char_length(lease_terms) <= 20000'),
      ('leases',           'ck_lease_text_len',             'lease_text is null or char_length(lease_text) <= 5000000'),
      ('leases',           'ck_lease_email_fmt',            'tenant_email is null or (char_length(tenant_email) <= 320 and tenant_email ~ ''^[^@\s]+@[^@\s]+\.[^@\s]+$'')'),
      ('leases',           'ck_lease_contact_len',          'tenant_contact_name is null or char_length(tenant_contact_name) <= 200'),
      ('rent_escalations', 'ck_esc_value',                  'escalation_value is null or (escalation_value >= 0 and escalation_value < 1e12)'),
      ('rent_escalations', 'ck_esc_newrent',                'new_base_rent >= 0 and new_base_rent < 1e12'),
      ('renewal_options',  'ck_ren_term',                   'term_months is null or (term_months >= 0 and term_months <= 1200)'),
      ('renewal_options',  'ck_ren_rent',                   'new_rent is null or (new_rent >= 0 and new_rent < 1e12)'),
      ('expense_records',  'ck_exp_taxes',                  'taxes_total >= 0 and taxes_total < 1e12'),
      ('expense_records',  'ck_exp_cam',                    'cam_total >= 0 and cam_total < 1e12'),
      ('expense_records',  'ck_exp_roof',                   'roof_total >= 0 and roof_total < 1e12'),
      ('expense_records',  'ck_exp_year',                   'year between 1900 and 2200'),
      ('cam_line_items',   'ck_cam_label_len',              'char_length(label) between 1 and 300'),
      ('cam_line_items',   'ck_cam_amount',                 'amount >= 0 and amount < 1e12'),
      ('cam_line_items',   'ck_cam_year',                   'year between 1900 and 2200'),
      ('insurance_policies','ck_ins_insurer_len',           'insurer is null or char_length(insurer) <= 300'),
      ('insurance_policies','ck_ins_coverage',              'coverage_amount is null or (coverage_amount >= 0 and coverage_amount < 1e15)'),
      ('insurance_policies','ck_ins_text_len',              'policy_text is null or char_length(policy_text) <= 5000000'),
      ('insurance_policies','ck_ins_path_len',              'storage_path is null or char_length(storage_path) <= 1024'),
      ('service_contracts','ck_sc_name_len',                'name is null or char_length(name) <= 300'),
      ('service_contracts','ck_sc_vendor_len',              'vendor is null or char_length(vendor) <= 300'),
      ('service_contracts','ck_sc_amount',                  'amount is null or (amount >= 0 and amount < 1e12)'),
      ('service_contracts','ck_sc_text_len',                'contract_text is null or char_length(contract_text) <= 5000000'),
      ('lease_files',      'ck_lf_filename_len',            'original_filename is null or char_length(original_filename) <= 512'),
      ('lease_files',      'ck_lf_path_len',                'char_length(storage_path) <= 1024')
      -- (business_profile constraints intentionally omitted — that table was dropped in 0009_corp_sender)
    ) as v(tbl, cname, expr)
  loop
    if not exists (
      select 1 from pg_constraint where conname = c.cname
    ) then
      execute format('alter table public.%I add constraint %I check (%s) not valid;', c.tbl, c.cname, c.expr);
      execute format('alter table public.%I validate constraint %I;', c.tbl, c.cname);
    end if;
  end loop;
end;
$$;

-- ===========================================================================
-- 3) Storage: restrict the documents bucket to known-safe types + a size cap
-- ---------------------------------------------------------------------------
-- The app only ever uploads lease/insurance/contract documents (PDF or images).
-- Pinning allowed_mime_types blocks HTML/SVG/scripts/executables at the storage
-- API itself, and file_size_limit caps abusive uploads — independent of any
-- client-side check, which can be bypassed.
-- ===========================================================================
update storage.buckets
   set file_size_limit = 26214400,  -- 25 MiB
       allowed_mime_types = array[
         'application/pdf',
         'image/png',
         'image/jpeg',
         'image/webp',
         'image/gif'
       ]
 where id = 'lease-documents';

-- ===========================================================================
-- 5) Security / audit event log
-- ---------------------------------------------------------------------------
-- App-level audit trail for "authentication attempts, API errors, and unusual
-- traffic" — complements Supabase's own auth.audit_log_entries. Edge functions
-- record events here (denied calls, rate-limit hits, server errors) via the
-- SECURITY DEFINER log_security_event() helper, which can attribute the actor
-- even when the request is unauthenticated (actor null). RLS: a user may READ
-- their own events; nobody can write through the API (only the definer fn).
-- ===========================================================================
create table if not exists public.security_events (
  id          bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_id    uuid references auth.users(id) on delete set null,
  event_type  text not null,            -- e.g. 'auth_denied', 'rate_limited', 'api_error', 'validation_rejected'
  fn          text,                     -- which edge function / endpoint
  detail      text,                     -- short, non-sensitive description
  ip          text
);
create index if not exists security_events_actor_idx on public.security_events (actor_id, occurred_at desc);
create index if not exists security_events_type_idx  on public.security_events (event_type, occurred_at desc);

alter table public.security_events enable row level security;
do $$ begin
  create policy security_events_read_own on public.security_events
    for select using (actor_id = auth.uid());
exception when duplicate_object then null; end $$;

create or replace function public.log_security_event(
  p_event_type text,
  p_fn         text default null,
  p_detail     text default null,
  p_actor      uuid default null,
  p_ip         text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.security_events (actor_id, event_type, fn, detail, ip)
  values (
    coalesce(p_actor, auth.uid()),
    left(coalesce(p_event_type, 'unknown'), 64),
    left(p_fn, 128),
    left(p_detail, 1000),
    left(p_ip, 64)
  );
end;
$$;

revoke all on function public.log_security_event(text, text, text, uuid, text) from public;
-- authenticated may log via the user-scoped edge client; the service role (used
-- by functions that run without a user JWT) can call it regardless.
grant execute on function public.log_security_event(text, text, text, uuid, text) to authenticated;
