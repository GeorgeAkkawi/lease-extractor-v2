-- 0088_payment_source.sql
-- Where a payment row CAME FROM, stored rather than guessed.
--
-- THE BUG THIS FIXES. resyncYearBillingToEstimate (api.js) re-prices a year's invoice when a
-- billed figure moves, and re-stamps the months the landlord had marked paid so the ✓ boxes
-- follow the new figure. That is correct for a box the APP filled in — the landlord clicked
-- "this month is settled", so the amount should track what the month owes. It is catastrophic
-- for a real cheque: the row is DELETED and replaced with an amount that never arrived, so the
-- ledger stops agreeing with the bank and no statement will ever reconcile against it.
--
-- The guard that separated the two inferred provenance from the ABSENCE of evidence:
--
--     p.import_id == null && (p.note == null || p.note === '')
--
-- i.e. "no import id and no note" was taken to mean "the app made this up". But the two ways a
-- landlord records a real amount — the Ledger cell click and the month panel's "Record $X
-- received" — both leave the note null, because markMonthPaid only sets one if a caller passes
-- it and no caller does. So every hand-recorded payment was eligible for deletion.
--
-- A note is something the landlord may or may not feel like typing. It cannot carry a rule
-- about whether money is real. So provenance becomes a column:
--
--   'system' — the app wrote the amount from the schedule (a "mark paid" click, "✓ all",
--              the catch-up sweep, or a previous re-stamp). Safe to re-price.
--   'manual' — a human typed this figure. NEVER re-priced.
--   'import' — it came off a bank statement. NEVER re-priced.
--
-- A SECOND THING THIS FIXES, quietly: import_id is `on delete set null` (0063), so deleting a
-- statement import used to strip its payments back to the "looks like a system mark" shape and
-- make real bank money re-writable. `source` survives the delete.
--
-- Additive, idempotent, non-destructive. Default 'system' matches the old guard's assumption,
-- so the back-fill below only ever makes rows SAFER, never more re-writable.

alter table payments
  add column if not exists source text not null default 'system';

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'ck_pay_source'
  ) then
    alter table payments add constraint ck_pay_source
      check (source in ('system', 'manual', 'import'));
  end if;
end $$;

-- ---- Back-fill ------------------------------------------------------------------------
-- Classify what already exists. The first two rules reproduce exactly what the old guard
-- already believed, so nothing that was protected yesterday becomes re-writable today.

-- Anything that came off a bank statement.
update payments set source = 'import'
 where source = 'system' and import_id is not null;

-- Anything the landlord annotated. (InvoicesPanel's manual entry is the path that fills this.)
update payments set source = 'manual'
 where source = 'system' and note is not null and note <> '';

-- ⚠ THE ONE THING THE BACK-FILL CANNOT KNOW is which note-less rows were a real cheque typed
-- by hand versus a "mark paid" click — the old code stored nothing that distinguishes them, so
-- historic rows keep their old (permissive) classification and only NEW rows are recorded
-- honestly. One case IS recoverable, and it is the one that loses the most money: the month
-- panel's "Record $X received" always posts as an ADDITIONAL payment on a month that already
-- has one. So on any (invoice, month) with more than one untagged payment, everything after
-- the earliest is a hand-entered top-up closing a shortfall — real money, never re-priced.
update payments p set source = 'manual'
 where p.source = 'system'
   and p.period_month is not null
   and exists (
     select 1 from payments q
      where q.invoice_id = p.invoice_id
        and q.period_month = p.period_month
        and q.id <> p.id
        and (q.created_at, q.id) < (p.created_at, p.id)
   );

comment on column payments.source is
  'Provenance: system = the app wrote the amount from the schedule (re-pricable when a billed '
  'figure moves); manual = a human typed it; import = it came off a bank statement. Only '
  'system rows may be re-stamped by resyncYearBillingToEstimate — see 0088 for why a null '
  'note is not a safe proxy for this.';
