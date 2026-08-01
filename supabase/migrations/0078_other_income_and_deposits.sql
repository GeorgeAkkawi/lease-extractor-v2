-- 0078 — money IN that isn't rent, and the security deposit as a lease term.
--
-- THE GAP, AND IT IS THE MORE DANGEROUS HALF OF SLICE 4. A deposit on a bank
-- statement has exactly two destinations today: a tenant lease, or Ignore. So a late
-- fee, parking income, a utility reimbursement, an insurance payout or a security
-- deposit must either be booked AGAINST A LEASE — which credits it toward that
-- tenant's annual invoice, so `allocatePayments` reads the month over-paid and the
-- Ledger's Collected column overstates rent collection — or dropped entirely.
--
-- That is the mirror of round 7's distributions gap with one crucial difference:
-- **a distribution going unrecorded OMITS a number; a deposit booked as rent CORRUPTS
-- one the landlord trusts.** Which is why this round exists.
--
-- ⚠ TWO NEW CONCEPTS, TWO DIFFERENT SHAPES, AND THEY ARE DELIBERATELY NOT ONE TABLE.
-- Round 7 folded three kinds into `entity_ledger` because a draw, a contribution and
-- an entity cost all mean "not the property's operating result". Here the two halves
-- fall on OPPOSITE sides of that line:
--
--   * OTHER INCOME **is** the property's income. It belongs in what actually stayed,
--     with a plus sign. It gets a table.
--   * A SECURITY DEPOSIT **is a liability** — the tenant's money, held. It belongs in
--     NO income figure anywhere, ever.
--
-- Putting them in one table with a `kind` would make "sum the income" one forgotten
-- filter away from counting held deposits as revenue. Keeping them apart makes that
-- mistake structurally impossible rather than merely avoided — the same argument
-- round 7 made for keeping draws out of `expense_records`.
--
-- ⚠ AND THE DEPOSIT NEEDS NO TABLE AT ALL. What is HELD is a lease term, so it lives
-- on the lease. What ARRIVED is a bank line, and 0076 already records every bank line
-- with a disposition and a `ref` — so a deposit line pointing at its lease IS the
-- corroboration. Creating a third place a deposit figure can live is precisely how
-- two of them start disagreeing. The cross-check reads the lease and the lines:
-- *the lease says $5,000 is held; the bank shows $5,000 received.* Amlak holds both
-- sides, which no accounting package can.
--
-- WHAT THIS DOES NOT DO. It alters no existing table except adding one nullable lease
-- column and widening one CHECK. It touches NO view (verified: `v_tenant_shares`
-- selects explicit `l.` columns, never `l.*`, and `v_property_totals` reaches leases
-- only through `effective_rent(l.id, …)` — so neither needs a rebuild), adds no RPC,
-- and changes no stored total. `create_lease_tx` needs no change either: it uses
-- `jsonb_populate_record` (0053), so it picks the new column up on its own.

-- 1) The security deposit the lease STATES is held --------------------------------
alter table public.leases add column if not exists security_deposit numeric(14,2);

comment on column public.leases.security_deposit is
  'What the lease says is held as a security deposit. A TERM, not a transaction — the '
  'money arriving is a bank line with disposition ''deposit_held'' pointing at this lease, '
  'and the two are cross-checked against each other rather than one being derived from '
  'the other. NEVER income: it is the tenant''s money, held, and is returned or applied '
  'at move-out. Distinct from the `no_security_deposit` review flag, which answers '
  'whether the lease REQUIRES one — this answers whether one is HELD.';

-- 2) Income that is real, is the property's, and is not rent ----------------------
create table if not exists public.other_income (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  -- NOT NULL, unlike entity_ledger's: this is the BUILDING's income. A late fee, a
  -- parking space and a laundry machine all belong to a property.
  property_id uuid not null references public.properties (id) on delete cascade,
  -- ⚠ THE COLUMN THAT MAKES THIS SAFE. A late fee genuinely comes FROM a tenant, and
  -- recording who paid it is real information — but it must never reach `payments`,
  -- because that is what would credit their invoice and make the Ledger read the
  -- month over-paid. So attribution lives here, in a table no billing code reads.
  -- `on delete set null`: removing a tenant must not erase income you actually received.
  lease_id    uuid references public.leases (id) on delete set null,
  year        int,
  -- The kind of income, from the JS registry in src/lib/otherIncome.js. No CHECK, for
  -- the reason 0075/0076/0077 all give: a CHECK means a migration every time the list
  -- grows, and it would reject a row the app considers valid.
  category    text,
  label       text,
  amount      numeric(14,2) not null default 0,
  txn_date    date,
  note        text,
  -- Provenance. Cascade is the backstop; undoStatementImport deletes these rows
  -- EXPLICITLY, because the demo mock has no foreign keys and a cascade-only design
  -- would pass the whole suite while orphaning rows live (the `not()` incident,
  -- mockClient.js:155).
  import_id   uuid references public.statement_imports (id) on delete cascade,
  line_hash   text,
  created_at  timestamptz not null default now()
);

create index if not exists other_income_prop_idx on public.other_income (property_id, year);
create index if not exists other_income_lease_idx on public.other_income (lease_id);
create index if not exists other_income_import_idx on public.other_income (import_id);

alter table public.other_income enable row level security;

do $$
begin
  create policy owner_all on public.other_income
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null;
end $$;

-- Every owner-scoped table carries this since 0052. Dormant until a user enrols a
-- second factor; it must not be the one table that forgets.
do $$
begin
  create policy require_aal2 on public.other_income
    as restrictive for all
    using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null;
end $$;

comment on table public.other_income is
  'Income the property really received that is not tenant rent — late fees, parking, '
  'laundry and vending, utility reimbursements, insurance proceeds. Read by NO view, NO '
  'invoice and NO share calculation, so it can never move a tenant''s bill; it is carried '
  'BESIDE v_property_totals.noi in the "what actually stayed" strip, because redefining '
  'NOI would silently re-value every chart point and every financial_snapshots row '
  'already written.';

-- 3) The importer learns two more destinations ------------------------------------
-- `target_kind` answers "which of Amlak's destinations does this dollar hit", and both
-- of these are genuinely new destinations — the same test that admitted round 7's four
-- and rejected a tax category in 0075 (a different axis entirely).
do $$
begin
  alter table public.import_rules drop constraint if exists import_rules_target_kind_check;
  alter table public.import_rules add constraint import_rules_target_kind_check
    check (target_kind in (
      'tenant', 'expense_tax', 'expense_cam', 'expense_roof', 'expense_other', 'ignore',
      'owner_draw', 'owner_contribution', 'entity_cost', 'transfer',
      'other_income', 'deposit_held'
    ));
end $$;
