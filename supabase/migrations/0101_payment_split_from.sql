-- 0101 — WHICH payment a rolled-forward surplus came out of
--
-- George, 2026-08-17: *"need a way to undo a roll forward."*
--
-- Rolling a surplus forward (0's `splitPayment`, shipped the same day) takes one payment row
-- and makes it two: the original drops to what its month billed, and the remainder becomes a
-- new row tagged to the month the landlord picked. Undoing it means merging the second back
-- into the first — and nothing recorded WHICH first.
--
-- ⚠ STORED, NOT INFERRED, and the reason is the same one payments.source (0088) and
-- signature_envelopes.declined_at (0096) exist for. The two halves of a split share a
-- paid_date, a method, an import_hash and a lease, so a merge could be guessed at from those
-- — and a wrong guess moves a landlord's money onto a month nobody chose. There is no
-- tolerable failure rate for that. A heuristic that is right today is also one edited note or
-- one duplicated cheque away from being wrong in front of an accountant.
--
-- ⚠ `on delete set null`, NOT cascade. If the parent is deleted (an un-ticked month, an Undo)
-- the child is still REAL MONEY that reached the bank — cascading would delete a deposit
-- because its sibling went away, which is the exact shape of the fault the tie-out found on
-- Pershing Plaza in July. Orphaned, it simply stops offering to merge and says why.
--
-- NULL on every payment written before this migration, which is every payment there has ever
-- been: nothing was split before the feature existed, so there is nothing to back-fill and no
-- row whose meaning changes.
--
-- ⚠ NOT ON THE MONEY SPINE. This column is read by one screen and one refusal. It moves no
-- rent, no CAM and no invoice: `allocatePayments` sums what is tagged to a month and has never
-- cared how many rows carry it. Splitting and merging are already invisible to it, which is
-- precisely why the link had nowhere else to live.

alter table public.payments
  add column if not exists split_from uuid references public.payments (id) on delete set null;

create index if not exists payments_split_from_idx on public.payments (split_from);

comment on column public.payments.split_from is
  'The payment this row was split out of when a surplus was rolled forward to another month '
  '(splitPayment, api.js). Undo merges the amount back into that row and deletes this one. '
  'Null on a payment that was recorded directly, and on any row whose parent has since been '
  'deleted — on delete set null, because this half is real money that reached the bank and '
  'must not vanish with its sibling.';
