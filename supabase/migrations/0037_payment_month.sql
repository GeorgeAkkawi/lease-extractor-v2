-- 0037_payment_month.sql
-- Monthly rent tracker: tag each payment with the calendar month (1-12) it covers.
-- The per-lease 12-box grid and the property rent roll read this to map paid/unpaid
-- deterministically instead of parsing notes. Additive + nullable — existing payments
-- (annual or partial, untagged) are unaffected and simply have period_month = null.
-- RLS is unchanged: the existing owner_all policy already covers the new column.

alter table payments
  add column if not exists period_month int
    check (period_month is null or period_month between 1 and 12);

comment on column payments.period_month is
  'Calendar month (1-12) this payment covers, for the monthly rent tracker. Null = untagged / non-monthly payment.';
