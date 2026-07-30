-- 0071 — a renewal option can carry its OWN rent schedule.
--
-- George, 2026-07-30: "if the rent goes up yearly or within a certain term amount the
-- user should have to option to update that like 'add rent escalation as part of this
-- option' and that should be hidden but be remembered so that when the renewal is
-- applied the escalations save."
--
-- Until now an option could express its rent two ways: a flat `new_rent` for the whole
-- option term, or `annual_escalation_pct` (compounded on apply). A lease that prints a
-- rent PER YEAR of the option period had nowhere to put it — the landlord could only
-- record year 1 and lose the rest.
--
-- The schedule is remembered ON the option and materialized into real rent_escalations
-- ONLY when the renewal is applied (rollLeaseIntoRenewal). That is what makes it
-- "hidden but remembered": nothing appears on the rent ledger for a renewal the tenant
-- has not exercised, and declining or deleting the option takes its schedule with it
-- rather than leaving orphaned steps behind.
--
-- Shape deliberately mirrors what buildRenewalScheduleSteps already consumes from the
-- AI read (`annualizeOptionSchedule`, _shared/rentSchedule.js), so the extracted and
-- hand-entered paths speak one vocabulary:
--
--   [{"months_from_option_start": 0,  "annual": 41403},
--    {"months_from_option_start": 12, "annual": 42645}]
--
-- Additive and nullable: every existing option keeps behaving exactly as it does today.

alter table public.renewal_options
  add column if not exists rent_schedule jsonb;

-- An array or nothing — a stray object/scalar here would silently produce no steps on
-- apply, which is the failure mode worth refusing outright.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.renewal_options'::regclass
      and conname = 'ck_ren_rent_schedule'
  ) then
    alter table public.renewal_options
      add constraint ck_ren_rent_schedule
      check (rent_schedule is null or jsonb_typeof(rent_schedule) = 'array');
  end if;
end $$;

comment on column public.renewal_options.rent_schedule is
  'Rent steps INSIDE this option period, [{months_from_option_start, annual}]. Hidden '
  'until the option is applied, then written as dated rent_escalations by '
  'rollLeaseIntoRenewal. Null = the option prices itself with new_rent / '
  'annual_escalation_pct as before.';
