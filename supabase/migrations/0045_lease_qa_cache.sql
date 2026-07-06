-- 0045_lease_qa_cache.sql
-- Cache for the cross-lease AI answers (the "who's responsible for the roof?" feature).
-- One row per (owner, property, normalized question, corpus fingerprint): while nothing
-- about the property's leases has changed, the same question returns the stored answer
-- for $0 instead of paying the model again. When any lease/rider is added, edited, or
-- removed the fingerprint changes, so stale answers simply stop matching.
--
-- Owner-scoped RLS, same permission shape as user_preferences (0038) / alert_states.
-- Additive and non-destructive — no existing object is touched.

create table if not exists public.lease_qa_cache (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  property_id        uuid        not null references public.properties (id) on delete cascade,
  question_norm      text        not null,
  corpus_fingerprint text        not null,
  answer_json        jsonb       not null,
  created_at         timestamptz not null default now(),
  unique (user_id, property_id, question_norm, corpus_fingerprint)
);
alter table public.lease_qa_cache enable row level security;

-- A user may read AND write only their own cached answers.
do $$ begin
  create policy lease_qa_cache_owner_all on public.lease_qa_cache for all
    using (user_id = auth.uid()) with check (user_id = auth.uid());
exception when duplicate_object then null; end $$;
