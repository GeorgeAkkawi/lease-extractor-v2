-- 0069: store the AI red-flag review on the lease.
--
-- A lease is read end-to-end by the Sonnet analyst at import; asking it the landlord-side
-- checklist ("what protection is missing here?") costs one extra output line on a read
-- already paid for. This column is where that answer lands so it survives, renders on the
-- lease page, and doesn't need re-reading every time the page is opened. A lease imported
-- before this shipped gets the same review on demand from the review-lease edge function,
-- which writes the identical shape.
--
--   { "flags": [ { "key": "no_personal_guarantee",
--                  "severity": "high" | "medium" | "info",
--                  "title": "...", "note": "...", "quote": "..." | null } ],
--     "model": "claude-sonnet-4-6",
--     "reviewed_at": "2026-07-29T…Z",
--     "source": "extract_lease" | "review_button" }
--
-- Metadata only: nothing here bills, splits, or schedules anything, so no view, invoice or
-- schedule reads it. Nullable + defaulted-null, so every existing lease is untouched.
--
-- Non-destructive and idempotent: one add-column-if-not-exists. No view rebuild needed —
-- v_tenant_shares (0058) and v_property_totals (0049) both select explicit column lists,
-- never leases.*, so neither picks this up. create_lease_tx (0053) uses
-- jsonb_populate_record, so a new lease carries its review through with no function change
-- (the same way premises_address rode in on 0058).

alter table public.leases add column if not exists ai_review jsonb;

comment on column public.leases.ai_review is
  'AI red-flag review: { flags:[{key,severity,title,note,quote}], model, reviewed_at, source }. Written by extract-lease at import and by the review-lease function on demand. Advisory metadata only — never used in any billing calculation.';
