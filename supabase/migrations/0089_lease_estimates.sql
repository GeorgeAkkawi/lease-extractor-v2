-- 0089 — the CAM & tax estimate gets DATES, the way the rent already has them.
--
-- George, 2026-08-04: *"the rent might change mid way through the year due to a new lease. if
-- that happens it should be recorded as it needs to be in the ledger so that when statements
-- come in the payments match, but the CAM is recalculated. the previous months aren't affected
-- and shouldn't be reconciled at the new figures because they would be part of the old lease."*
--
-- THE ASYMMETRY THIS CLOSES. A rent change has somewhere to live: `rent_escalations` is a
-- ledger of dated facts, and `monthlyBases` reads it to price January at the old rate and
-- August at the new one. The CAM & tax estimate has nowhere — it is a bare scalar on
-- `leases` (est_cam_annual / est_tax_annual / est_roof_annual). So "the previous months aren't
-- affected" was unrepresentable for CAM: raise the estimate in August and every month back to
-- January was re-priced, retroactively, including months the tenant had already paid.
--
-- Worse, the year-end ⚖ Reconcile settled `actual − (today's annual estimate)` — the whole
-- year at whatever figure happened to be on the lease when the landlord clicked. A mid-year
-- change landed entirely in the baseline, so the true-up was wrong by (Δestimate × the months
-- billed at the old rate) — in the wrong direction, and invisibly.
--
-- ⚠ WHY A TABLE AND NOT A PARAMETER. Two cheaper designs were tried and rejected:
--   ① Thread an "effective month" through resyncYearBillingToEstimate and recover the earlier
--      months from the stored invoice. NOT IDEMPOTENT — the split would live in a derived
--      annual figure that a dozen legitimate callers overwrite (addAdjustment, the
--      resyncPropertyBilling fan-out, every explicit estimate save), so the next unrelated
--      resync erases it silently. A split needs a durable home.
--   ② Reconcile against the invoice instead of the estimate. OVERCHARGES every mid-year-start
--      tenant: the invoice's cam_annual is already prorated by in-term/12 while the actual
--      share is a full-year figure, so a July-start tenant's true-up roughly quadruples.
--
-- ⚠ AN EMPTY TABLE REPRODUCES TODAY'S BEHAVIOUR EXACTLY. monthlyEstimates() falls straight
-- back to the lease's scalar for every month when there are no rows, which is what makes this
-- shippable without a flag day and why there is no back-fill below. Rows are written only by a
-- change that CARRIES a date — a new lease applied, a rider — and never by the deliberate
-- estimate editors (the Financials inline cell, the lease-page field), because there the
-- landlord typed this year's figure on this year's screen and meant it for the whole year.
--
-- ⚠ TWO ROWS PER CHANGE, not one — the same rule the rent boundary follows. monthlyEstimates
-- answers the LIVE scalar for the current era, so a boundary row alone still leaves January on
-- the new figure. A closing row carrying the OLD estimate is what gives the old era a rate.
--
-- Additive. One plain table. No view, no RPC, no column on any existing table, so nothing
-- stored can move and v_tenant_shares / v_invoice_balances are untouched.

create table if not exists public.lease_estimates (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  lease_id       uuid not null references public.leases (id) on delete cascade,
  -- The day this estimate took effect. Same semantics as rent_escalations.effective_date:
  -- it prices that month and every month after it, until the next row.
  effective_date date not null,
  -- The COMBINED CAM & tax figure, matching the convention the whole app bills from (a
  -- combined estimate is stored on leases as est_cam_annual with est_tax_annual = 0, so
  -- `cam + tax` is always the combined amount). Null = "this row says nothing about CAM &
  -- tax", so a roof-only change doesn't have to invent one.
  cam_tax_annual numeric,
  roof_annual    numeric,
  -- Where the row came from: 'new_lease' | 'addendum'. Free text, no CHECK — same reason
  -- 0075-0082 kept their vocabularies in JS: a CHECK means a migration every time the list
  -- is refined, and it would reject a row the app considers valid.
  source         text,
  addendum_id    uuid references public.lease_addendums (id) on delete set null,
  note           text,
  created_at     timestamptz not null default now(),
  constraint ck_lease_est_amounts check (
    (cam_tax_annual is null or (cam_tax_annual >= 0 and cam_tax_annual < 1e12)) and
    (roof_annual    is null or (roof_annual    >= 0 and roof_annual    < 1e12))),
  constraint ck_lease_est_note check (note is null or char_length(note) <= 2000)
);

create index if not exists lease_estimates_lease_idx on public.lease_estimates (lease_id, effective_date);

alter table public.lease_estimates enable row level security;

do $$ begin
  create policy owner_all on public.lease_estimates
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Dormant until a user enrols an authenticator (0052), like every other owner table.
do $$ begin
  create policy require_aal2 on public.lease_estimates
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;

comment on table public.lease_estimates is
  'Dated CAM & tax / roof estimates — the ledger that lets a mid-year change price the months '
  'before it at the OLD figure. Empty table = the lease scalar applies to the whole year, '
  'which is exactly the behaviour that existed before 0089. See monthlyEstimates() in '
  'src/lib/reconciliation.js, the JS twin of this rule.';
