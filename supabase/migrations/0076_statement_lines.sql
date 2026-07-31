-- 0076_statement_lines.sql
-- Slice 4a — every line accounted for. One row per TRANSCRIBED bank line, each
-- carrying a disposition. George's rule: a dollar that crossed the bank is either
-- recorded somewhere or explicitly left out with a reason. Never dropped.
--
-- Additive / non-destructive: ONE new owner-scoped table. No existing table, view,
-- function or row is touched, so no bill can move. Safe to re-run.
--
-- Rule-#7 check (views selecting X.* from an ALTERED table): nothing is altered.
-- statement_lines is brand new and no view selects from it. Being a plain table it
-- carries NO mirror obligation — the demo mock auto-creates unknown tables
-- (mockClient.js:240) — so §3 is satisfied without a mockClient change.
--
-- WHAT WAS ACTUALLY BROKEN. A line nothing recognized arrived unticked; saving
-- without touching it produced no write and NO RECORD THAT IT EVER EXISTED.
-- statement_imports.applied stores every write an import MADE and nothing about the
-- lines it passed over, so "did I ever book that Comcast bill?" had no answer inside
-- the app — the stored PDF was the only trace, and a PDF is not queryable.
--
-- THIS DOES NOT REPLACE `applied`, AND THE DISTINCTION IS THE WHOLE DESIGN:
--   • statement_imports.applied is the UNDO record — what to reverse, keyed to live
--     rows, replayed backwards by undoStatementImport.
--   • statement_lines is the AUDIT record — what the statement SAID and what we
--     decided about it. It stays true even after the row it produced is edited or
--     hand-deleted later.
-- Which is exactly why ref_id below is NOT a foreign key: deleting a payment must
-- not rewrite history to claim the import never booked one.
--
-- WHY disposition IS NOT NULL WITH A DEFAULT, AND HAS NO CHECK. Not null because the
-- entire point is that no line is ever in an unknown state — 'unclassified' is a
-- real, visible, counted answer, never a silent null. No CHECK because the vocabulary
-- lives in a JS registry (src/lib/dispositions.js), the same call 0075 made for
-- expense categories: rounds 7 and 8 add members (owner · entity · transfer · debt ·
-- capital · other_income · deposit_held), and a CHECK would mean a migration per
-- member and would reject a row the app considers valid.
--
-- import_id CASCADES on purpose. Undoing an import deletes its statement_imports row
-- so its hashes leave the dedupe universe and the statement is cleanly re-importable;
-- surviving line rows would then be orphans asserting money was recorded that isn't.
-- The import didn't happen, so its lines didn't either.

create table if not exists public.statement_lines (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  import_id     uuid not null references public.statement_imports (id) on delete cascade,
  -- Denormalized from the import so "what is unplaced on this property this year?" is
  -- one filter rather than a join — the demo mock has no joins, and this is the same
  -- call history_events.tenant_name made in 0040.
  property_id   uuid references public.properties (id) on delete cascade,
  -- The line's OWN fiscal year, derived from its own date at match time — a Dec/Jan
  -- statement legitimately carries lines in two years.
  year          int,
  txn_date      date,
  description   text,
  amount        numeric(14,2) not null default 0,
  direction     text not null default 'out',
  -- The same lineHash the duplicate guard already computes, kept so a line can be
  -- traced to the payment it produced and back.
  line_hash     text,
  disposition   text not null default 'unclassified',
  -- Only meaningful when disposition = 'ignored'. Null there means "left out, reason
  -- not given" — still a decision, just an unexplained one, and the UI offers the
  -- reasons after the fact rather than putting words in the landlord's mouth.
  ignore_reason text,
  -- What this line produced, for audit. Plain columns, NO foreign key — see above.
  ref_kind      text,
  ref_id        uuid,
  created_at    timestamptz not null default now()
);

-- The two questions this table exists to answer, both hot paths:
--   "what did this import do with every line?"  → by import
--   "what is still unplaced on this property?"  → by property + year
create index if not exists statement_lines_import_idx
  on public.statement_lines (import_id);
create index if not exists statement_lines_unplaced_idx
  on public.statement_lines (property_id, year)
  where disposition = 'unclassified';

alter table public.statement_lines enable row level security;

do $$ begin
  create policy owner_all on public.statement_lines for all
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- The 0052 second gate: dormant until a user enrols an authenticator, then required.
do $$ begin
  create policy require_aal2 on public.statement_lines
    as restrictive to authenticated using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null; end $$;
