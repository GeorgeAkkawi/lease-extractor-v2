-- 0068: a renewal option whose NOTICE window belonged to a superseded term is lapsed.
--
-- apply_due_renewals() judged staleness on the committed term end alone. That misses the
-- common shape where an addendum has extended a lease past an old option: the term end is
-- comfortably in the future, so a decade-old option still reads as a live decision and the
-- cron raises "Is <tenant> renewing?" every morning — with a Yes button that would book the
-- option's original-era rent against today's.
--
-- Real case (George, 2026-07-28): a 2004 lease's "First Option to Renew" — notice by
-- 2008-09-01, rent $19,386 — sitting pending on a lease whose addendums carried the term to
-- 2030-05-31 at a current $31,800.96.
--
-- The rule: a notice deadline that has PASSED and sits more than 18 months before the
-- committed term end cannot be the notice window for this term. Real windows are "180 days
-- prior", "twelve (12) months prior" and the like, so 18 months leaves generous headroom.
--
-- JS twin: optionLapseReason() in src/lib/renewals.js — used by the lease page's option
-- table and by isRenewalDecisionDue/promptDueRenewalDecisions. Change both together.
--
-- Non-destructive: one create-or-replace of an existing function. No schema change, no
-- data change. The only rows it removes are stale renewal_decision PROMPTS, which are
-- regenerated from the options themselves whenever a decision is genuinely due.

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
  v_lead int;
  v_stale_cutoff date;
  v_count integer := 0;
begin
  -- Clear stale prompts: the lease's term has since ended (option lapsed unexercised), OR
  -- the option that raised the prompt has a notice deadline belonging to an earlier term.
  -- `< least(today, term_end - 18 months)` is exactly "already passed AND more than 18
  -- months before the term end".
  delete from public.notifications n
   using public.leases lz
   where n.lease_id = lz.id
     and n.kind = 'renewal_decision'
     and lz.lease_termination_date is not null
     and (
       lz.lease_termination_date < public.app_today()
       or (select ro.notice_by_date
             from public.renewal_options ro
            where ro.lease_id = lz.id
              and ro.status = 'pending'
            order by ro.notice_by_date nulls last
            limit 1)
          < least(public.app_today(),
                  (lz.lease_termination_date - interval '18 months')::date)
     );

  for l in
    select * from public.leases
     where is_active
       and lease_termination_date is not null
       and lease_termination_date >= public.app_today()   -- term not yet ended
  loop
    select * into r
      from public.renewal_options
     where lease_id = l.id and status = 'pending'
     order by notice_by_date nulls last
     limit 1;
    continue when not found;

    -- Lapsed by notice window → not a live decision; never prompt.
    v_stale_cutoff := least(public.app_today(),
                            (l.lease_termination_date - interval '18 months')::date);
    continue when r.notice_by_date is not null and r.notice_by_date < v_stale_cutoff;

    -- a bit before the deadline: notice-by date if stated, else the owner's renewal
    -- lead (default ~6 months) before term end.
    v_lead := coalesce(
      (select (notify_lead_times->>'renewal')::int from public.user_preferences where user_id = l.owner_id),
      183);
    v_trigger := coalesce(r.notice_by_date, (l.lease_termination_date - (v_lead || ' days')::interval)::date);
    continue when public.app_today() < v_trigger;

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
