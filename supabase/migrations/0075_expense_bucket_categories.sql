-- 0075_expense_bucket_categories.sql
-- Slice 2 — an expense bucket stops being emergent free text and becomes a RECORD
-- that carries a tax category, chosen once and applied to every line that bucket
-- has ever held and every line it ever will.
--
-- Additive / non-destructive: ONE new owner-scoped table. No existing table, view,
-- function or row is touched, so no bill can move. Safe to re-run.
--
-- Rule-#7 check (views selecting X.* from an ALTERED table): nothing is altered.
-- expense_buckets is brand new and no view selects from it. Being a plain table it
-- also carries NO mirror obligation — the demo mock auto-creates unknown tables
-- (mockClient.js:240) — so §3 is satisfied without a mockClient change.
--
-- WHY A TABLE AND NOT A COLUMN. Today the bucket list is a Map built at RUNTIME from
-- the distinct labels already typed (api.js, getStatementMatchContext). That is
-- genuinely good onboarding — you never configure anything — and it stays as the
-- seed and the fallback: an uncategorized label still imports and still bills exactly
-- as it does now. What it cannot do is HOLD a decision. A category is a judgement the
-- landlord makes once ("Landscaping is Cleaning and maintenance"), and a Map rebuilt
-- from labels every request has nowhere to keep it.
--
-- TWO REFUSALS, both deliberate, both load-bearing:
--
--   1. The category does NOT go on cam_line_items. It is a property of the BUCKET, not
--      of each payment — putting it on the line would ask the same question every time
--      a landscaping invoice arrives, and let two lines in one bucket disagree.
--
--   2. import_rules.target_kind is NOT extended. target_kind answers "which of Amlak's
--      money buckets does this dollar hit" — a BILLING question with exactly six
--      correct answers, driving resolvePick and applyStatementImport. The tax category
--      is a different axis entirely: "Landscaping" is a tenant-facing CAM bucket,
--      "Cleaning and maintenance" is a tax line the tenant never sees, and MANY buckets
--      map to ONE category. Collapsing the two axes would force a dozen meaningless
--      branches through the import path.
--
-- WHY category IS NULLABLE. An uncategorized bucket must be a visible dollar figure,
-- never silently absorbed into "Other". Defaulting to 'Other' would hide exactly what
-- this slice exists to surface — and George's own January import already learned a
-- bucket literally named "Other", which is the failure mode in miniature. Null means
-- "nobody has said yet", and the UI shows it as a number that wants an answer.
--
-- The category VALUES live in a JS registry (src/lib/expenseCategories.js), not in a
-- CHECK constraint or an enum — matching how this codebase already does registries
-- (FEATURES, NOTIFY_TYPES). The list is the union of Form 8825 and Schedule E because
-- George's filing form is unsettled ("my CPA handles it"): one list serves both and
-- the export names whichever the CPA wants. A CHECK here would mean a migration every
-- time that list is refined, and would reject a row the app considers valid.

create table if not exists public.expense_buckets (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid not null references auth.users (id) on delete cascade,
  label         text not null check (char_length(btrim(label)) > 0),
  -- null = not yet categorized. Deliberately not defaulted — see the note above.
  category      text,
  -- The bucket's DEFAULT billable-ness for new lines. Each cam_line_items row keeps
  -- its own billable flag (0064) and stays authoritative for what was actually billed;
  -- this only pre-answers the checkbox.
  billable      boolean not null default true,
  -- Slice 5 reads this: a big spend in a capital-prone bucket (roof, HVAC, paving) is
  -- the one that should offer "capitalize as an asset" at review. Stored now because
  -- it is a property of the bucket and costs nothing to carry.
  capital_prone boolean not null default false,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- One bucket per (owner, label), case- and whitespace-insensitive — so "Snow removal"
-- and "snow removal " are the same bucket and saving a category again UPDATES rather
-- than stacking a duplicate. Owner-wide, NOT per-property, matching the runtime Map it
-- replaces: a bucket named once is offered on every property, so its category should
-- be answered once too.
create unique index if not exists expense_buckets_owner_label_idx
  on public.expense_buckets (owner_id, lower(btrim(label)));

drop trigger if exists trg_expense_buckets_updated on public.expense_buckets;
create trigger trg_expense_buckets_updated
  before update on public.expense_buckets
  for each row execute function set_updated_at();

alter table public.expense_buckets enable row level security;

do $$ begin
  create policy owner_all on public.expense_buckets for all
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- The 0052 second gate: dormant until a user enrols an authenticator, then required.
do $$ begin
  create policy require_aal2 on public.expense_buckets
    as restrictive to authenticated using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null; end $$;
