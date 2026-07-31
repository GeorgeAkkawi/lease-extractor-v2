-- 0072 — remember a renewal option's notice deadline as the DURATION the lease states.
--
-- George, 2026-07-30: "for the renewal tab make sure i can click into notice by and
-- change the duration to something specific like how many months before"
--
-- A lease never prints a notice DATE. It prints a duration — "180 days prior to the
-- expiration of the then-current term", "twelve (12) months prior" — and the date falls
-- out of when that term ends. Until now `notice_by_date` held only the resolved date, so
-- the app could show WHEN notice is due but had no idea what rule produced it: the
-- landlord had to do the arithmetic by hand, and if the term later moved (an addendum
-- extends it, an earlier option is exercised) the stored date quietly stopped meaning
-- what the lease says.
--
-- These two columns record the rule alongside the answer. `notice_by_date` stays the
-- single resolved date every consumer already reads — the lapse rule (0068), the bell
-- prompt, apply_due_renewals(), the renewal_notice reminder trigger (0002) — so nothing
-- downstream changes shape. The lead is purely what lets the app say the rule back
-- ("6 months before") and re-date it when the period it counts back from moves.
--
-- Both null = the deadline was entered as a plain date, which is exactly how every
-- existing option behaves today. Additive and nullable throughout.

alter table public.renewal_options
  add column if not exists notice_lead_n    integer,
  add column if not exists notice_lead_unit text;

-- The pair is meaningful only together, and only as a positive count of days or months.
-- A half-written pair would render as a rule the app can't actually resolve, so refuse
-- it outright rather than store something that reads true and computes nothing.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.renewal_options'::regclass
      and conname = 'ck_ren_notice_lead'
  ) then
    alter table public.renewal_options
      add constraint ck_ren_notice_lead
      check (
        (notice_lead_n is null and notice_lead_unit is null)
        or (notice_lead_n > 0 and notice_lead_unit in ('days', 'months'))
      );
  end if;
end $$;

comment on column public.renewal_options.notice_lead_n is
  'How far ahead of the option period notice is due, as a count — the lease''s own rule '
  '("180 days prior"). Paired with notice_lead_unit. Null = the deadline was entered as '
  'a plain date. notice_by_date remains the resolved date everything else reads.';

comment on column public.renewal_options.notice_lead_unit is
  '''days'' or ''months'' — the unit for notice_lead_n. Counted back from the day the '
  'term this option would extend runs out (the day before the option period starts).';
