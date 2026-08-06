-- 0098_entity_ledger_party.sql
--
-- WHO the money went to (or came from), on an entity_ledger row.
--
-- THE GAP. 0077 gave a distribution somewhere to go; it did not record who took it.
-- A real month: check 1329 → Lana Akkawi $20,000, check 1330 → Yazin Akkawi $10,000,
-- check 1331 → Khaled Akkawi $70,000. All three are correctly `kind='draw'` and
-- correctly out of NOI — and all three collapse into ONE "Owner draws: $100,000" line
-- on the CPA package, because summarizeEntityLedger sums by kind and nothing else.
-- A multi-member LLC files Form 1065 with a K-1 per member, and a distribution
-- allocates per member and drives that member's capital account. One lumped figure
-- sends the accountant back to the check images.
--
-- ⚠ AND THE APP CANNOT INFER IT, WHICH IS WHY THIS IS A STORED FIELD AND NOT A PARSE.
-- The machine-readable check line a bank publishes is `1329 | Jan 6 | 8351300884 |
-- 20,000.00`. The payee exists only as handwriting in the check IMAGE. So an imported
-- draw always arrives with this column null, and naming it afterwards (in place, via
-- setEntityLedgerParty — never delete-and-re-add, which would orphan line_hash and
-- break the import's undo) is the primary path, not a convenience.
--
-- WHY FREE TEXT AND NOT A MEMBERS TABLE. A members table means ownership percentages,
-- capital accounts and allocation rules — a real design that wants an accountant's
-- input, not a column. George chose the smaller thing deliberately. So: a name, with
-- autocomplete built from the names already used on that corporation, and no second
-- table to keep in step. The CHECK below guards LENGTH only; a CHECK on the VALUE
-- would be the members table this deliberately isn't (same reasoning as 0077's
-- refusal to CHECK `kind`, and 0075's category list living in JS).
--
-- ⚠ THIS MUST NOT REACH A PROPERTY METRIC. entity_ledger is read by no view, no
-- invoice and no share calculation — that separation IS 0077, and it is what makes a
-- draw recorded here safe where a draw recorded as a "not billed" expense was not.
-- `party` inherits it: it surfaces on the CPA package's "Not on this return" sheet and
-- the lender package's "Not included" sheet, and nowhere that computes NOI, an expense
-- total, or a tenant's share.
--
-- Additive, nullable, idempotent, non-destructive. No view is touched, so there is no
-- security_invoker concern; RLS (`owner_all`, 0077) is unaffected by a column add. An
-- existing row reads null — "not attributed" — which is exactly what it is, and why
-- there is no back-fill.

alter table public.entity_ledger add column if not exists party text;

do $$ begin
  alter table public.entity_ledger add constraint ck_entity_party
    check (party is null or char_length(party) <= 120);
exception when duplicate_object then null; end $$;

comment on column public.entity_ledger.party is
  'Who the money went to (draw, cost) or came from (contribution). Free text, nullable — '
  'null means not attributed. Never reaches NOI, an expense total or a tenant share.';
