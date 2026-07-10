-- 0059_annual_reports.sql
-- Annual state filings: every corporation must file an annual report by a fixed
-- date each year. One row per corporation, holding the NEXT filing deadline, the
-- last-filed date, the uploaded report documents, and an email-dedupe bucket.
--
-- Additive / non-destructive: a brand-new owner-scoped table only — no changes to
-- any existing table, view, or function. Safe to re-run (IF NOT EXISTS + guarded
-- policy creation).
--
--   • due_date            — the next filing deadline (rolls +1 year when the landlord
--                           marks it filed or uploads the new year's report).
--   • last_filed_date     — set by "Mark filed" / a new upload.
--   • docs jsonb          — array of { path, uploaded_at } so every year's report
--                           stays on record (no second table needed).
--   • due_notice_bucket   — dedupes the owner reminder email (same pattern as
--                           insurance_policies.expiry_notice_bucket / migration 0031),
--                           reset to null in the save helper when due_date changes.
--
-- RLS mirrors insurance_policies (owner_all) PLUS the require_aal2 RESTRICTIVE policy
-- that 0052/0056 apply to every owner-scoped data table, so a bare-password (aal1)
-- session can't read a corporation's filing dates once 2FA is enrolled.

create table if not exists public.annual_reports (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  corporation_id    uuid not null references public.corporations (id) on delete cascade,
  due_date          date,
  last_filed_date   date,
  docs              jsonb not null default '[]'::jsonb,
  due_notice_bucket text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One annual-report record per corporation (the save helper upserts on this).
create unique index if not exists annual_reports_corp_idx
  on public.annual_reports (corporation_id);

drop trigger if exists trg_annual_reports_updated on public.annual_reports;
create trigger trg_annual_reports_updated
  before update on public.annual_reports
  for each row execute function set_updated_at();

alter table public.annual_reports enable row level security;

do $$ begin
  create policy owner_all on public.annual_reports for all
    using (owner_id = auth.uid())
    with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Same aal2 enforcement as every other owner-scoped table (0052). RESTRICTIVE =>
-- ANDed with owner_all; the second branch lets aal1 through for any user who has
-- not enrolled a factor, so this is dormant until 2FA is turned on.
do $$ begin
  create policy require_aal2 on public.annual_reports
    as restrictive to authenticated using (
      (select auth.jwt() ->> 'aal') = 'aal2'
      or not public.user_has_verified_mfa()
    );
exception when duplicate_object then null; end $$;
