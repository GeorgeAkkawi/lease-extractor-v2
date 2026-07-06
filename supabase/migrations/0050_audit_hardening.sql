-- 0050 — audit hardening (all additive / idempotent / non-destructive):
--   1. Preserve a tenant's billing history when the lease is removed. Deleting a
--      lease cascades to its invoices + payments (0023), so archiveLease now
--      snapshots them into this jsonb column BEFORE the delete. No data model change
--      to the live invoices/payments — this is just a durable archive copy.
--   2. Guarantee at most ONE open "renewal_decision" prompt per lease. Both the
--      nightly cron and the on-load client can create these; with no uniqueness a
--      race produced duplicate prompts. A partial unique index makes duplicates
--      impossible; the cron insert now no-ops on conflict and the client swallows
--      the 23505.
--   3. Stop unauthenticated (anon) callers from invoking the security-audit logger
--      and the AI rate-limit counter directly. The app calls these as the service
--      role (reminders/health) or the authenticated user (rate limiter), so those
--      keep working — only the anon spoofing path is closed.

-- 1. Billing-history snapshot on the archive -------------------------------------
alter table public.expired_leases
  add column if not exists financials jsonb;

-- 2. One open renewal_decision per lease -----------------------------------------
-- Clear any pre-existing duplicates first (keep the enriched/newest row per lease)
-- so the unique index can be created. No-op when there are none.
delete from public.notifications n
 where n.kind = 'renewal_decision'
   and n.lease_id is not null
   and n.id not in (
     select distinct on (lease_id) id
       from public.notifications
      where kind = 'renewal_decision' and lease_id is not null
      order by lease_id, (email_body is not null) desc, created_at desc
   );

create unique index if not exists notifications_one_open_renewal_decision
  on public.notifications (lease_id)
  where kind = 'renewal_decision';

-- Recreate the cron so its prompt insert defers to the unique index instead of
-- racing the check-then-insert. Identical to the live definition except for the
-- `on conflict … do nothing` clause on the insert.
create or replace function public.apply_due_renewals()
 returns integer
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  l record;
  r record;
  v_prop record;
  v_years int;
  v_rent_label text;
  v_trigger date;
  v_count integer := 0;
begin
  -- Clear stale prompts for leases whose term has since ended (option lapsed).
  delete from public.notifications n
   using public.leases lz
   where n.lease_id = lz.id
     and n.kind = 'renewal_decision'
     and lz.lease_termination_date is not null
     and lz.lease_termination_date < current_date;

  for l in
    select * from public.leases
     where is_active
       and lease_termination_date is not null
       and lease_termination_date >= current_date   -- term not yet ended
  loop
    select * into r
      from public.renewal_options
     where lease_id = l.id and status = 'pending'
     order by notice_by_date nulls last
     limit 1;
    continue when not found;

    -- a bit before the deadline: notice-by date if stated, else ~6 months before term end
    v_trigger := coalesce(r.notice_by_date, (l.lease_termination_date - interval '6 months')::date);
    continue when current_date < v_trigger;

    perform 1 from public.notifications where lease_id = l.id and kind = 'renewal_decision';
    continue when found;

    select * into v_prop from public.properties where id = l.property_id;
    v_years := floor(coalesce(r.term_months, 12) / 12.0)::int;
    v_rent_label := case
      when r.new_rent is not null then to_char(r.new_rent, 'FM$999,999,999')
      when coalesce(r.annual_escalation_pct, 0) > 0 then '+' || r.annual_escalation_pct || '%/yr'
      else 'the current rent' end;

    insert into public.notifications
      (owner_id, lease_id, property_id, corporation_id, kind, title, body, read)
    values (
      l.owner_id, l.id, l.property_id, v_prop.corporation_id, 'renewal_decision',
      'Is ' || l.tenant_name || ' renewing?',
      coalesce(r.option_label, 'A renewal option') || ' — ' || v_years ||
        '-yr extension at ' || v_rent_label ||
        '. Confirm only if the tenant is exercising it; it won''t change the term until you do.',
      false
    )
    on conflict (lease_id) where kind = 'renewal_decision' do nothing;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

-- 3. Close the anon path on the audit logger + rate-limit counter -----------------
-- authenticated + service_role keep their explicit grants; only anon/public lose it.
revoke execute on function public.log_security_event(text, text, text, uuid, text) from public;
revoke execute on function public.log_security_event(text, text, text, uuid, text) from anon;
revoke execute on function public.ai_rate_check(integer, integer) from public;
revoke execute on function public.ai_rate_check(integer, integer) from anon;
