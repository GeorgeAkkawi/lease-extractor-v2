-- 0077 — money that crossed the bank but is not the building's income or expense.
--
-- THE GAP. Amlak has exactly four homes for a dollar: tenant rent, property taxes,
-- CAM, roof. Every other thing a landlord's account really sees is homeless, and
-- `IGNORE_KEYWORDS` (statementMatch.js) bins DRAW / TRANSFER by keyword — correctly,
-- they are not recoverable CAM — and then records them NOWHERE. **Every distribution
-- George has ever taken is invisible to the app.** Round 6 made those lines visible
-- as `unclassified`; this round gives them somewhere to go.
--
-- ⚠ THE ACCOUNTING FACT THAT DECIDES THE WHOLE DESIGN. A distribution is NOT an
-- expense — it reduces EQUITY, not income. So it must never reach `expense_records`,
-- never touch `cam_total`, never enter `v_tenant_shares`, and never appear in NOI.
-- Booking a draw into a "not billed to tenants" bucket (which is where it would
-- naturally land today) would understate income by exactly the amount the CPA taxes.
-- That is not hypothetical: 401 S Main currently carries "Liana $20,000" and
-- "Yazin $10,000" as not-billed EXPENSES, and both read like owner draws.
--
-- WHY ONE TABLE AND NOT THREE. A draw, a contribution and an entity-level cost have
-- one shape and differ only in what they mean, so the meaning lives in `kind` plus a
-- JS registry (`src/lib/entityLedger.js`) — the same shape as FEATURES, NOTIFY_TYPES,
-- EXPENSE_CATEGORIES and 0076's dispositions. There is deliberately NO CHECK on
-- `kind` for the same reason 0075 kept its category list in JS: a CHECK means a
-- migration every time the list is refined, and it would reject a row the app
-- considers valid. The one constraint that IS enforced is the one that matters —
-- `corporation_id` is NOT NULL, because this is entity-level money by definition.
--
-- ⚠ `property_id` IS NULLABLE AND THAT IS NOT LAZINESS. An entity cost (registered
-- agent, franchise tax) genuinely belongs to no single building. But an imported line
-- always knows which property's account it left, and recording that is free
-- information — it is what lets the per-property strip show what actually left that
-- account with NO allocation guess. `on delete set null`: deleting a property must
-- not erase a draw that really happened.
--
-- ⚠ WHAT THIS DOES NOT DO. It does not make `expense_records.property_id` nullable —
-- that would break every view's join and drag mockClient.js with it. It alters no
-- existing table except widening one CHECK, touches no view, and adds no RPC. Not one
-- stored total can move.

create table if not exists public.entity_ledger (
  id             uuid primary key default gen_random_uuid(),
  owner_id       uuid not null references auth.users (id) on delete cascade,
  -- Entity-level money by definition: there is always a corporation, and it is the
  -- axis the roll-up sums on.
  corporation_id uuid not null references public.corporations (id) on delete cascade,
  -- Which account it left, when we know. Never guessed, never allocated.
  property_id    uuid references public.properties (id) on delete set null,
  year           int,
  -- 'draw' | 'contribution' | 'cost'. See src/lib/entityLedger.js — no CHECK, on
  -- purpose (0075/0076 precedent).
  kind           text not null,
  -- Only a 'cost' has a tax category, and it is nullable for the same reason 0075's
  -- bucket category is: defaulting it to 'Other' would hide exactly what wants
  -- surfacing. A draw carries none — a distribution files on no line of any return.
  category       text,
  label          text,
  amount         numeric(14,2) not null default 0,
  txn_date       date,
  note           text,
  -- Provenance. Cascade is the backstop; undoStatementImport deletes these rows
  -- EXPLICITLY, because the demo mock has no foreign keys and a cascade-only design
  -- passes the whole suite while orphaning rows live (the `not()` incident,
  -- mockClient.js:155).
  import_id      uuid references public.statement_imports (id) on delete cascade,
  line_hash      text,
  created_at     timestamptz not null default now()
);

create index if not exists entity_ledger_corp_idx on public.entity_ledger (corporation_id, year);
create index if not exists entity_ledger_prop_idx on public.entity_ledger (property_id, year);
create index if not exists entity_ledger_import_idx on public.entity_ledger (import_id);

alter table public.entity_ledger enable row level security;

do $$ begin
  create policy owner_all on public.entity_ledger
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Dormant until a user enrols an authenticator (0052), like every other owner table.
do $$ begin
  create policy require_aal2 on public.entity_ledger
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;

-- A learned payee rule can now point at one of the new homes. This is the extension
-- 0075 deliberately REFUSED for tax categories and this round accepts: `target_kind`
-- answers "which of Amlak's destinations does this dollar hit", and a distribution is
-- a genuinely new destination — unlike a tax category, which is a different axis
-- entirely. Constraint-only; every existing row keeps its value.
do $$ begin
  alter table public.import_rules drop constraint if exists import_rules_target_kind_check;
  alter table public.import_rules add constraint import_rules_target_kind_check
    check (target_kind in (
      'tenant','expense_tax','expense_cam','expense_roof','expense_other','ignore',
      'owner_draw','owner_contribution','entity_cost','transfer'
    ));
exception when undefined_table then null; end $$;
