-- 0082 — a per-month charge or credit on one tenant: the tenant sub-ledger.
--
-- THE GAP. The Rent Ledger can SHOW that a month came in off — the box stays a forest ✓
-- and its figure turns gold with a "short $649.44" chip — but there is nowhere to say
-- why and nothing to do about it. A month's `owed` is DERIVED, never stored
-- (leaseSchedule.js: annualBase ÷ 12 + otherAnnual ÷ 12), and its base/CAM&tax/roof
-- split is two ANNUAL figures divided by twelve. **The only per-month money column in
-- the entire schema is `payments.period_month` (0037).** So a one-off correction — the
-- CAM was different that month, a late fee, a concession — has nothing to land in.
--
-- ⚠ WHAT THIS IS NOT. The accounting direction doc refuses a GENERAL LEDGER: "a second
-- source of truth for dollars that already have one." This is not that. No chart of
-- accounts, no journal entries, no double entry, no second place NOI can be computed.
-- It is a ONE-SIDED tenant sub-ledger whose every dollar resolves into the ONE per-month
-- `owed` the app already derives. It adds a term to an existing equation rather than
-- standing up a parallel system.
--
-- ⚠ THE ONE RULE THAT MAKES IT SAFE, and it is enforced in JS, not here:
--
--     An adjustment changes what is OWED. It never changes what was RECEIVED,
--     and it never counts itself as covered.
--
-- Two silent-corruption paths follow from getting that wrong. ① `resyncYearBillingToEstimate`
-- re-records any month whose payments are all system marks whenever the recorded total
-- differs from `owed` — so a +$400 charge would DELETE the $5,000 payment and write
-- $5,400, asserting money that never arrived. It therefore re-stamps to the SCHEDULED
-- owed, never the adjusted owed. ② `allocatePayments` sets settled ⇒ coverage = owed, so
-- a charge on an already-paid month would be invisible; a settled month's coverage caps
-- at the SCHEDULED owed instead. With no adjustments both are byte-identical.
--
-- ⚠ SIGNED AMOUNT, DELIBERATELY. `entity_ledger` (0077) stores a magnitude and takes its
-- sign from the kind, because a draw is always out. Here the sign is genuinely per-row —
-- a CAM correction goes either way — so it lives on the row and `kind` is only the
-- category. That IS debits and credits: + = charge (debit the tenant), − = credit.
--
-- NO CHECK on `kind`, for the same reason 0075/0076/0077/0079/0080 kept their
-- vocabularies in JS: a CHECK means a migration every time the list is refined, and it
-- would reject a row the app considers valid. `src/lib/adjustments.js` owns the list and
-- makes the unknown-key refusal.
--
-- ⚠ NOTHING ELSE MOVES. One new plain table. No view, no RPC, no edge function, and NO
-- column on `invoices` — which matters: `v_invoice_balances` selects `i.*` (0055/0061),
-- so an invoice column would force a DROP+CREATE of that view in this same migration.
-- The invoice's `total_amount` carries Σ adjustments and the month shape comes from the
-- rows, so no schema change is needed there. Not one stored total can move.

create table if not exists public.lease_adjustments (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  -- A charge or credit belongs to ONE tenant on ONE month, by definition — both NOT NULL.
  lease_id    uuid not null references public.leases (id) on delete cascade,
  -- Carried so the Ledger can read a whole property's adjustments in one query without
  -- joining back through leases (the propertyRentRoll path fetches per property).
  property_id uuid not null references public.properties (id) on delete cascade,
  year        int not null,
  month       int not null check (month between 1 and 12),
  -- 'base' | 'camtax' | 'fee' | 'credit'. See src/lib/adjustments.js — no CHECK, on purpose.
  kind        text not null,
  -- SIGNED: + = charge (debit the tenant), − = credit. Never a magnitude.
  amount      numeric(14,2) not null,
  memo        text,
  created_at  timestamptz not null default now()
);

create index if not exists lease_adjustments_lease_idx on public.lease_adjustments (lease_id, year);
create index if not exists lease_adjustments_prop_idx on public.lease_adjustments (property_id, year);

alter table public.lease_adjustments enable row level security;

do $$ begin
  create policy owner_all on public.lease_adjustments
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Dormant until a user enrols an authenticator (0052), like every other owner table.
do $$ begin
  create policy require_aal2 on public.lease_adjustments
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;
