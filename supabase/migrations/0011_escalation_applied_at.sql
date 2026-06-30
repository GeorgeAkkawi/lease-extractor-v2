-- 0011_escalation_applied_at.sql
-- Escalations now apply automatically ON their effective date (not via an early
-- manual button), updating the lease's base rent. Record when each was applied.
alter table rent_escalations
  add column if not exists applied_at timestamptz;
