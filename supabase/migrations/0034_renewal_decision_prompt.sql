-- 0034_renewal_decision_prompt.sql
-- Renewal options are the tenant's RIGHT to extend — never a commitment. Previously
-- apply_due_renewals() silently rolled a lease into its pending option once the term
-- date passed, which extended the committed term without the landlord's say-so (and,
-- combined with the resolver chaining pending options, pushed lease_termination_date
-- far into the future). New model:
--   • A pending option NEVER changes the term on its own.
--   • When a decision is due (the option's notice-by date, else ~6 months before the
--     committed term end, else once the term has lapsed) we drop a ONE-TIME
--     'renewal_decision' notification asking the landlord "Is the tenant renewing?".
--   • The landlord answers in-app: Confirm (confirmRenewal) rolls the lease into the
--     new term; Decline (declineRenewal) marks the option 'declined'.
-- This mirrors the JS promptDueRenewalDecisions / confirmRenewal / declineRenewal.

-- 1) Allow the new terminal status 'declined' on renewal options.
alter table public.renewal_options drop constraint if exists renewal_options_status_check;
alter table public.renewal_options
  add constraint renewal_options_status_check
  check (status in ('pending', 'applied', 'declined'));

-- 2) apply_due_renewals() — REPURPOSED. It no longer applies anything; it only drops
--    the "Is the tenant renewing?" prompt when a decision is due and none is open yet.
--    Never modifies a lease. Keeps the same name so the pg_cron schedule (0022) and
--    the daily job keep calling it. Hardened: security definer, empty search_path.
create or replace function public.apply_due_renewals()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  r record;
  v_prop record;
  v_years int;
  v_rent_label text;
  v_trigger date;
  v_count integer := 0;
begin
  for l in
    select * from public.leases
     where is_active
       and lease_termination_date is not null
  loop
    -- the lease's first pending option (the one a decision would apply)
    select * into r
      from public.renewal_options
     where lease_id = l.id and status = 'pending'
     order by notice_by_date nulls last
     limit 1;
    continue when not found;

    -- decision window opens at the notice-by date if stated, else ~6 months before
    -- the committed term end; and stays open once the term has lapsed.
    v_trigger := coalesce(r.notice_by_date, (l.lease_termination_date - interval '6 months')::date);
    continue when current_date < v_trigger;

    -- one open prompt per lease at a time — don't re-ask if we already did
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
    );
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.apply_due_renewals() from public, anon, authenticated;
