-- 0090 — an estimate ledger can say "there was NO estimate for this era".
--
-- 0089 gave the CAM & tax estimate a dated ledger so that a mid-year change stops re-pricing
-- the months before it. It works whenever the lease already carried an estimate: the closing
-- row holds the old figure, the boundary row the new one, and monthlyEstimates reads January
-- off the closing row.
--
-- ⚠ IT DOES NOT WORK FOR THE COMMONEST SHAPE OF THE CHANGE — going from NO estimate to one.
-- applyNewLeaseTerms writes the closing row only when there is a prior figure to put on it
-- (`priorEst != null`), and monthlyEstimates falls back to the LIVE scalar for any month
-- before the first row. So a lease that had no estimate — and whose months were therefore
-- billed at the ACTUAL share (billedComponents: `est_cam_annual != null ? est : cam_amount`)
-- — has every month back to January re-billed at the new estimate the moment a new lease is
-- applied. That is exactly what 0089 was written to stop, in the case its own demo
-- drive-through demonstrates: `CAM & tax estimate  —  →  $14,700.00`.
--
-- The reason it could not be expressed: monthlyEstimates filters rows with `cam_tax_annual
-- != null`, so a null-valued row is invisible to it — and null already MEANS something else
-- on this table ("this row says nothing about CAM & tax", so a roof-only change needn't
-- invent one, 0089:53-54). Overloading it would break that.
--
-- Hence one boolean. `cam_tax_none = true` means: for the era beginning at effective_date,
-- this lease carried NO CAM & tax estimate — bill and reconcile the ACTUAL share, not any
-- figure later typed onto the lease.
--
-- ⚠ SCOPED TO CAM & TAX DELIBERATELY, not "no estimate at all". Roof needs no equivalent and
-- must not be swept up in one: est_roof_annual is not among the fields a new lease applies
-- (newLeaseTerms.js FIELDS), so a roof estimate never changes on this path. A lease with no
-- roof estimate writes roof_annual null on both rows → no roof rows → monthlyEstimates falls
-- back to live.roof, which IS the actual share. Correct already, and a shared flag would have
-- wiped a roof estimate that a CAM-only change has no business touching.
--
-- Additive, one column, default false — and false is byte-for-byte 0089's behaviour, so every
-- row already written keeps meaning exactly what it meant. No back-fill: a pre-0090 row was
-- only ever written WITH a figure (that was the condition for writing it), so there is no
-- historical row this flag would have been true for.

alter table public.lease_estimates
  add column if not exists cam_tax_none boolean not null default false;

-- A row can carry a figure or declare there wasn't one — never both. Catches the shape of
-- writer bug this column exists to make impossible.
do $$ begin
  alter table public.lease_estimates
    add constraint ck_lease_est_none check (not (cam_tax_none and cam_tax_annual is not null));
exception when duplicate_object then null; end $$;

comment on column public.lease_estimates.cam_tax_none is
  'True = this era had NO CAM & tax estimate; bill and reconcile the tenant''s ACTUAL share '
  'for these months rather than any figure later typed onto the lease. Distinct from a null '
  'cam_tax_annual, which means "this row says nothing about CAM & tax". See monthlyEstimates() '
  'in src/lib/reconciliation.js and its TS twin in supabase/functions/draft-invoice/index.ts.';
