-- 0102 — record the year's CAM & tax CORRECTIONS on the reconciliation row.
--
-- THE PROBLEM THIS FIXES IS AN ARITHMETIC CONTRADICTION IN A LETTER SENT TO A TENANT.
--
-- `reconcileFigures` folds a year's CAM & tax corrections (kind = 'camtax' lease_adjustments,
-- 0082) into the ESTIMATE side — correctly, because a correction the tenant was already billed
-- has to sit there or the true-up charges the same dollars twice. But `reconcileCamTax` stored
-- `est_cam` / `est_tax` as the PRE-correction figures beside `diff`, the POST-correction one,
-- and nothing on the row recorded the difference between them. The stored row therefore could
-- not be reconciled against itself, and the statement letter — which rebuilds its lines from
-- those columns — printed a per-line difference computed as (actual − est) beside a TOTAL row
-- carrying the stored `diff`. On a $400 correction that reads:
--
--     • CAM & tax — billed $12,000.00 · actual $12,300.00 · difference +$300.00
--       TOTAL     — billed $12,000.00 · actual $12,300.00 · difference −$100.00
--       REFUND DUE TO TENANT: $100.00
--
-- Two lines with identical figures and opposite differences, a refund matching neither, and
-- prose underneath saying expenses came in under estimate while the line above says over. The
-- reconciliation WORKBOOK has printed this figure as a named memo row since 2026-08-16
-- (`of which corrections billed during the year`); the emailed statement quoted a different
-- billed figure for the same lease-year because the column did not exist.
--
-- Additive, idempotent, non-destructive. Default 0 reproduces today's arithmetic exactly for
-- every row already stored (a reconciliation settled with no correction has nothing to add),
-- so there is no back-fill: the figure is unknowable for past rows and 0 is what they assumed.
alter table public.cam_reconciliations
  add column if not exists cam_tax_adjust numeric not null default 0;

comment on column public.cam_reconciliations.cam_tax_adjust is
  'CAM & tax corrections billed during the year (0082 lease_adjustments, kind=camtax). Already INSIDE diff via the estimate side — est_cam + est_tax + cam_tax_adjust is what the tenant was billed. Stated so the statement letter can name it instead of contradicting itself.';
