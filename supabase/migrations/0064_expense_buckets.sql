-- 0064_expense_buckets.sql
-- Expense buckets (Rent Ledger round 2): the itemized expense list gains named
-- buckets, including a "not billed to tenants" kind.
--
-- Additive / non-destructive: one ADD COLUMN with a default + one widened CHECK
-- constraint on import_rules — no rows changed, no view touched. Safe to re-run.
--
-- Rule-#7 check (views selecting X.* from an altered table): no view selects
-- cam_line_items.* — CAM totals live on the expenses record (`expenses.cam_total`),
-- maintained by the client-side re-sum — so no view rebuild is needed.
--
--   • cam_line_items.billable — true (default) = a normal CAM bucket, billed back
--     to tenants through their share exactly as today. false = the "Other — not
--     billed to tenants" bucket family: itemized in the Expense entry for the
--     landlord's own records but EXCLUDED from the CAM total re-sum, so it never
--     touches v_tenant_shares, tenant invoices, or reconciliation. Every existing
--     row defaults to billable (no billing change for anyone).
--   • import_rules.target_kind gains 'expense_other' — an "always" rule can now
--     remember a not-billed bucket (cam_label already names the bucket, 0063).

alter table public.cam_line_items
  add column if not exists billable boolean not null default true;

-- Widen the target_kind CHECK to include 'expense_other'. Constraint-only: the
-- new set is a strict superset of the old, so every existing row passes.
do $$ begin
  alter table public.import_rules drop constraint if exists import_rules_target_kind_check;
  alter table public.import_rules add constraint import_rules_target_kind_check
    check (target_kind in ('tenant','expense_tax','expense_cam','expense_roof','expense_other','ignore'));
end $$;
