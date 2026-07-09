-- 0057_notice_buckets.sql
-- Dedupe columns for two NEW owner-email reminder sweeps in the send-reminders edge
-- function (contract expiry + overdue rent). Additive / non-destructive: two nullable
-- columns only — no data loss, no view/function change, safe to re-run (IF NOT EXISTS).
--
-- Both mirror the proven insurance dedupe pattern (insurance_policies.expiry_notice_bucket,
-- migration 0031): the sweep records which threshold it last emailed for, so each
-- threshold (1 month → 2 weeks → 1 week → past-due) sends at most once.
--
--   • service_contracts.end_notice_bucket — contract-expiry reminder. Reset to null in
--     the contract-save helper (api.js) when end_date changes, the same way saveInsurance
--     re-arms expiry_notice_bucket, so a rescheduled contract re-notifies.
--   • invoices.overdue_notice_bucket — overdue-rent reminder. No reset logic needed: a
--     paid invoice drops out of v_invoice_balances (nothing to email), and a new year is a
--     brand-new invoice row with a null bucket.

alter table if exists public.service_contracts
  add column if not exists end_notice_bucket text;

alter table if exists public.invoices
  add column if not exists overdue_notice_bucket text;
