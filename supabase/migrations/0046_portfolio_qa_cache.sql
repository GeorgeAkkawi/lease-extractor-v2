-- 0046_portfolio_qa_cache.sql
-- Part 1 — retire the cross-lease AI-answer cache. The per-property lease search +
-- "who's responsible for the roof?" answer feature was removed; its cache only ever
-- held regenerable AI answers, so dropping it loses no real data.
--
-- Part 2 — add the cache for the new "Ask Amlak" portfolio assistant. One row per
-- (owner, normalized question, portfolio fingerprint): while nothing in the portfolio
-- has changed, the same question returns the stored answer for $0 instead of paying
-- the model again. Any lease / insurance / contract add / edit / remove changes the
-- fingerprint, so stale answers simply stop matching.
--
-- Owner-scoped RLS, same permission shape as lease_qa_cache (0045) / user_preferences
-- (0038). Additive apart from the intentional drop above.

drop table if exists public.lease_qa_cache;

create table if not exists public.portfolio_qa_cache (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  question_norm        text        not null,
  snapshot_fingerprint text        not null,
  answer_json          jsonb       not null,
  created_at           timestamptz not null default now(),
  unique (user_id, question_norm, snapshot_fingerprint)
);
alter table public.portfolio_qa_cache enable row level security;

-- A user may read AND write only their own cached answers.
do $$ begin
  create policy portfolio_qa_cache_owner_all on public.portfolio_qa_cache for all
    using (user_id = auth.uid()) with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;
