-- 0066_import_rule_account_hint.sql
-- Statement import, pattern-learning round: an "always" payee rule can now
-- remember which bank ACCOUNT it was learned from (the statement's masked hint,
-- e.g. "••4821"), so the same payee pattern on two different accounts resolves to
-- the right rule and a rule survives a tenant switching banks.
--
-- Additive / non-destructive: one nullable ADD COLUMN. No rows changed, no CHECK
-- touched, no view rebuilt. Safe to re-run.
--
--   • account_hint is METADATA, not identity. The identity of a rule is still
--     (owner_id, property_id, lower(pattern)) — its UNIQUE index is unchanged — so
--     re-learning the same pattern from a different account UPDATES the one rule
--     (last-import-wins), matching how the import already remembers account→property.
--     Matching reads it as a tie-breaker: a hint-matching rule is preferred, with a
--     plain pattern match as the fallback.
--
-- Rule-#7 check (views selecting X.* from an altered table): no view selects
-- import_rules.* — the table is read directly by the client — so no view rebuild is
-- needed. RLS is unchanged (the existing owner_all policy covers the new column).

alter table public.import_rules
  add column if not exists account_hint text;
