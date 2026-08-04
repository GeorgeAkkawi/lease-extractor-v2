-- 0083 — saved announcement templates: the one notice a landlord sends again and again.
--
-- THE GAP. Every tenant letter in this app is either CODE (src/lib/emailTemplates.js —
-- renewal, escalation, insurance, shortfall) or a ONE-SHOT AI draft that is never
-- persisted (api.js deliberately skips the portfolio_qa_cache write when `draft_for` is
-- set, 0046). Both are per-tenant by construction. A building-wide notice — "the lot is
-- being resurfaced the week of the 14th", "holiday hours", "your new property manager" —
-- is neither: it is the same prose to everyone, and it is sent AGAIN next winter with a
-- new date. There has never been anywhere to keep it.
--
-- ⚠ WHY A TABLE AND NOT localStorage. 0028 moved alert dismissals the other way — OFF
-- localStorage and INTO a table — because per-browser state does not follow the landlord
-- across devices. A saved template is exactly that kind of state: it is a small library
-- the landlord builds up over years and expects to find on any machine. (The half-typed
-- draft of a notice not yet sent is NOT — that stays in localStorage, keyed per property,
-- so an accidental window close doesn't cost the typing. Different lifetime, different
-- home.)
--
-- WHAT `ai_request` IS FOR. The template stores the landlord's original plain-English
-- instruction alongside the finished prose, so "↻ Rewrite with AI" can re-run the same
-- ask a year later and get fresh wording. Without it a reused template could only ever be
-- the old text with the date swapped. Nullable: a template typed by hand has no request.
--
-- HOW A REUSED TEMPLATE STAYS CURRENT. Not here — in JS. `src/lib/announcementTokens.js`
-- swaps the literal date / property name / business name for {date} / {property} /
-- {business} on save and back again on load. Storing tokens rather than a rendered letter
-- is what lets one template serve every property and every year. NO CHECK constraint on
-- the text columns, same reason 0075/0077/0079/0082 kept their vocabularies in JS: the
-- token list is refined in code, and a CHECK would reject a body the app considers fine.
--
-- ⚠ NOTHING ELSE MOVES. One new plain table. No view, no RPC, no trigger beyond the
-- standard updated_at, and not one stored dollar anywhere in the schema can change as a
-- result of it — an announcement is prose, never a billed figure.

create table if not exists public.announcement_templates (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  -- What the landlord calls it in the template list ("Snow removal notice").
  name         text not null,
  subject      text not null,
  -- The full letter, with {date} / {property} / {business} left in place of the values
  -- that must be re-resolved every time it is opened. See announcementTokens.js.
  body         text not null,
  -- The plain-English ask that produced it, if it was AI-drafted — replayed by the
  -- "↻ Rewrite with AI" button. Null for a hand-typed template.
  ai_request   text,
  last_used_at timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- The template list is always read newest-used-first for one owner.
create index if not exists announcement_templates_owner_idx
  on public.announcement_templates (owner_id, last_used_at desc nulls last);

drop trigger if exists trg_announcement_templates_updated on public.announcement_templates;
create trigger trg_announcement_templates_updated
  before update on public.announcement_templates
  for each row execute function set_updated_at();

alter table public.announcement_templates enable row level security;

do $$ begin
  create policy owner_all on public.announcement_templates
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Dormant until a user enrols an authenticator (0052), like every other owner table.
do $$ begin
  create policy require_aal2 on public.announcement_templates
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;

comment on table public.announcement_templates is
  'Reusable building-wide tenant notices. Body stores {date}/{property}/{business} tokens, '
  'resolved on load by src/lib/announcementTokens.js. Read by PropertyAnnouncementsModal only.';
