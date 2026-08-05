-- 0091 — a service contract gets the terms that actually cost money: RENEWAL, NOTICE,
-- and a DATED FEE SCHEDULE.
--
-- George, 2026-08-05: *"we need to add the same system to the contracts tab … from what i
-- remember the contracts display in expenses and all the escalations and renewals are
-- present in the contract tab but im sure theres more … the contract needs to functino on
-- notifications."*
--
-- What was actually there: `end_date` and a single `escalation_pct` scalar. No auto-renew
-- flag, no cancellation-notice window, no renewal term — and the demo's own canned contract
-- text says "Auto-renews annually unless cancelled with 30 days written notice", with
-- nowhere to put it. **The cancellation-notice date is the deadline that costs money**: miss
-- it and the agreement renews for another full term at the vendor's figure. Nothing watched
-- it, because nothing could store it.
--
-- ⚠ DELIBERATELY NO `status` COLUMN ON contract_escalations, and nothing ever writes
-- service_contracts.amount. The lease's rent_escalations carries a status because
-- `leases.base_rent` is read by a dozen surfaces that cannot reach the escalation ledger, so
-- a nightly apply_due_escalations() sweep has to push the figure onto the lease.
-- `service_contracts.amount` is read by THREE, and all three funnel through
-- contractAnnualCost() — which can simply take the steps. An applying sweep here would create
-- a JS↔SQL twin (CLAUDE.md §3) that buys nothing, and the CAM line item it feeds is ALREADY a
-- self-healing derivation. Statusless also makes a retroactive correction free: fix the step,
-- and every year that reads it re-prices on the next sync.
--
-- ⚠ new_amount IS IN THE CONTRACT'S OWN FREQUENCY. A monthly contract stores a MONTHLY
-- figure, because service_contracts.amount does. Store an annual figure on a monthly contract
-- and contractAnnualCost multiplies it by twelve.
--
-- ⚠ notice_by_date IS A PLAIN STORED COLUMN, not `generated always as (end_date - notice_days)`.
-- The demo mock implements no generated columns, so a generated column would be right live and
-- `undefined` in demo — the exact class of drift CLAUDE.md §3 exists to prevent. The derivation
-- lives once, in updateServiceContract().
--
-- ⚠ NO CHECK CONSTRAINTS on service_type / frequency / escalation_pct. Live rows predate those
-- vocabularies, and a CHECK a single stored row violates fails this migration in production.
-- Same reasoning as 0075-0082, 0089.
--
-- Additive and idempotent throughout: new nullable columns and one new table. Nothing stored
-- moves, no view changes, so v_tenant_shares / v_property_totals / v_invoice_balances are
-- untouched by this file.

-- 1) Renewal, notice and AI-read columns on the contract itself -----------------
alter table public.service_contracts
  -- Does the agreement renew by itself if nobody acts? This drives the WORDING of the
  -- notice alert ("it renews automatically if you miss it"), not whether the alert exists.
  add column if not exists auto_renew            boolean,
  -- The written-notice window the contract requires, in days ("thirty (30) days written
  -- notice of cancellation" → 30).
  add column if not exists notice_days           integer,
  -- The DATE by which that notice has to be given. Usually end_date − notice_days, but a
  -- contract that prints a specific date wins over the arithmetic, which is why this is
  -- stored rather than computed.
  add column if not exists notice_by_date        date,
  -- How long the next term runs if it does renew (months), so the alert can say what is
  -- being committed to.
  add column if not exists renewal_term_months   integer,
  -- The send-reminders dedupe stamp for the notice email, exactly the 0057 pattern
  -- (service_contracts.end_notice_bucket is its sibling for the expiry email). Reset to
  -- null by updateServiceContract whenever the date moves, so a rescheduled notice
  -- re-notifies.
  add column if not exists cancel_notice_bucket  text,
  -- The raw AI read of the contract document, kept for audit / re-review — the
  -- lease_files.extraction_raw equivalent.
  add column if not exists extraction_raw        jsonb,
  -- Per-field confidence from that read, for the badges on the contract row.
  add column if not exists ai_confidence         jsonb,
  -- The landlord-side red-flag review (see _shared/contractFlags.js), same shape as
  -- leases.ai_review.
  add column if not exists ai_review             jsonb;

comment on column public.service_contracts.notice_by_date is
  'The date written cancellation notice must be given by. Stored, not generated: a contract '
  'that prints a real date beats end_date - notice_days, and the demo mock has no generated '
  'columns. Derived in updateServiceContract() when the caller does not supply one.';

comment on column public.service_contracts.cancel_notice_bucket is
  'send-reminders dedupe stamp for the cancellation-notice email (0057 pattern). Nulled '
  'whenever notice_by_date / notice_days / end_date changes, so a rescheduled notice re-arms.';

-- 2) The dated fee schedule ------------------------------------------------------
create table if not exists public.contract_escalations (
  id              uuid primary key default gen_random_uuid(),
  owner_id        uuid not null references auth.users (id) on delete cascade,
  contract_id     uuid not null references public.service_contracts (id) on delete cascade,
  -- The day this fee takes effect. Read by CALENDAR YEAR: the step in effect for a fiscal
  -- year is the LAST step whose effective_date falls in that year or earlier. Not "on or
  -- before Jan 1" (which lags a mid-year-start contract a full year) and not "on or before
  -- Dec 31" (which would let a November step re-price the preceding January). Year-of
  -- comparison reproduces the pre-0091 `steps = year - startYear` compounding exactly.
  effective_date  date not null,
  -- The fee from that date, IN THE CONTRACT'S OWN FREQUENCY (monthly contract → a monthly
  -- figure). Mirrors service_contracts.amount, which this overrides for the years it covers.
  new_amount      numeric not null,
  -- 'fixed' | 'percent' | 'cpi' | 'manual' — descriptive only; the amount is authoritative.
  -- No CHECK, same reason as everywhere else: refining the vocabulary must not need a migration.
  escalation_type text,
  escalation_value numeric,
  -- Where the row came from: 'contract' (read off the document) | 'manual' (typed in).
  source          text,
  note            text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ck_contract_esc_amount check (new_amount >= 0 and new_amount < 1e12),
  constraint ck_contract_esc_note check (note is null or char_length(note) <= 2000)
);

create index if not exists contract_escalations_contract_idx
  on public.contract_escalations (contract_id, effective_date);

do $$ begin
  create trigger trg_contract_escalations_updated
    before update on public.contract_escalations
    for each row execute function set_updated_at();
exception when duplicate_object then null; end $$;

alter table public.contract_escalations enable row level security;

do $$ begin
  create policy owner_all on public.contract_escalations
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Dormant until a user enrols an authenticator (0052), like every other owner table.
do $$ begin
  create policy require_aal2 on public.contract_escalations
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;

comment on table public.contract_escalations is
  'Dated fee steps for a service contract. DERIVED, never applied: nothing writes '
  'service_contracts.amount, so there is no status column and no nightly sweep — '
  'contractAnnualCost(contract, year, steps) picks the step in effect. An empty table '
  'reproduces the pre-0091 escalation_pct behaviour byte for byte, which is why there is no '
  'back-fill. See src/lib/contracts.js, the single implementation of the rule.';
