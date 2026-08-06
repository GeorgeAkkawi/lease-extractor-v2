-- 0099_custom_expense_categories.sql
--
-- A tax category the landlord names, for when none of the built-in fifteen fit.
--
-- THE CONSTRAINT THAT SHAPES THIS, and it is not negotiable: EXPENSE_CATEGORIES is not a
-- free list, it is the UNION OF FORM 8825 AND SCHEDULE E (expenseCategories.js), and every
-- key maps to a real line in FORM_LINES (cpaPackage.js). You cannot invent a line on an IRS
-- form. A category that mapped to no line would produce a CPA package the accountant cannot
-- file — the exact opposite of what that package exists for.
--
-- SO A CUSTOM CATEGORY IS A NAMED WRITE-IN UNDER "OTHER". Both forms end with a write-in
-- line — 8825 line 15 "Other (list)", Schedule E line 19 "Other (list)" — where you are
-- EXPECTED to itemize your own descriptions. A custom category is exactly that: it rolls up
-- to `other` on both forms and carries its own label as the write-in text. That is why this
-- is an improvement rather than a compromise: today every unmatched cost lands in one lumped
-- "Other", and the form asks for the list Amlak was throwing away.
--
-- WHY A TABLE. The built-in fifteen live in JS on purpose (0075: "a CHECK would mean a
-- migration every time the list is refined"). A CUSTOM one is different in kind — it is
-- user data, not vocabulary the app ships — so it needs a row. Owner-scoped, because a
-- filing vocabulary belongs to the person filing, not to one building.
--
-- ⚠ THE KEY IS PREFIXED `custom:` AND THAT IS LOad-BEARING. It is stored in
-- expense_buckets.category and entity_ledger.category, which are plain nullable text with no
-- CHECK (0075 and 0077 both refused one). The prefix guarantees a custom key can never
-- collide with a built-in one — no built-in contains a colon — so those columns need no
-- migration, no back-fill, and no widening. A row written before this migration reads
-- exactly as it did.
--
-- ⚠ AND NOTHING HERE BILLS ANYTHING. 0075's rule carries over verbatim: a category is
-- reporting vocabulary — which line of a tax form a dollar rolls up to. What a TENANT is
-- charged is decided by cam_line_items.billable and the pro-rata share, untouched by this.
-- A mis-categorized bucket makes a wrong report and can never make a wrong invoice.
--
-- Additive: ONE new owner-scoped table. No existing table, view, function or row is touched,
-- so no stored total can move. Being a plain table it carries no mirror obligation — the demo
-- mock auto-creates unknown tables (mockClient.js:240) — so CLAUDE.md §3 is satisfied without
-- a mockClient change. Safe to re-run.

create table if not exists public.expense_categories_custom (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  -- 'custom:<slug>' — stable once written, because it is stored on every bucket and
  -- entity-ledger row that chose it. Renaming the LABEL must not orphan them, so the label
  -- is what changes and the key never does.
  key        text not null,
  -- The write-in text that appears on the form's "Other (list)" line.
  label      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_custom_cat_key   check (key like 'custom:%' and char_length(key) between 8 and 80),
  constraint ck_custom_cat_label check (char_length(btrim(label)) between 1 and 60)
);

-- One key per owner, and one LABEL per owner too — under the same identity rule buckets use
-- (lower(btrim(...))), so "Security", "security" and "Security " cannot become three
-- categories that all mean the same line of the return.
create unique index if not exists expense_categories_custom_key_idx
  on public.expense_categories_custom (owner_id, key);
create unique index if not exists expense_categories_custom_label_idx
  on public.expense_categories_custom (owner_id, lower(btrim(label)));

alter table public.expense_categories_custom enable row level security;

do $$ begin
  create policy owner_all on public.expense_categories_custom
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

drop trigger if exists set_updated_at on public.expense_categories_custom;
create trigger set_updated_at before update on public.expense_categories_custom
  for each row execute function public.set_updated_at();

comment on table public.expense_categories_custom is
  'Landlord-named tax categories. Each rolls up to the "Other (list)" line of Form 8825 / '
  'Schedule E and supplies its label as that line''s write-in text. Reporting only — a '
  'category never reaches a tenant''s bill.';
