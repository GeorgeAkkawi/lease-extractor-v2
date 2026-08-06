-- 0096 — WHEN the other side refused to sign
--
-- George, 2026-08-06: *"i want the app to start automatically reloading when small things
-- like that happen… for updates that are important like those email responses."*
--
-- A tenant declining is a response — arguably the one that matters most, because it means the
-- addendum, extension or renewal the landlord thought was in flight is dead. Until now it
-- raised NOTHING on the dashboard (0085 deliberately skipped an envelope "merely waiting on
-- the tenant", and the refusal fell through the same gap): the only signal was the Resend
-- email and a red badge on a page you had to already be looking at.
--
-- The alert wants to say WHEN, and the row could not say it. `signature_envelopes` stores
-- signed_at, executed_at and applied_at as siblings and had no fourth for the decline —
-- declined_reason recorded WHY with nothing recording when.
--
-- ⚠ STORED, NOT INFERRED. `updated_at` holds the right instant today only because a declined
-- envelope is terminal and nothing touches it afterwards — the same reasoning that made
-- payments.source (0088) a stored column rather than a guess off a null note. A timestamp
-- that is correct by accident is one refactor from being wrong in the landlord's face.
--
-- NULL on every row that declined before this migration. The alert already handles it (it
-- prints the reason without a date, exactly as signature_countersign does for a missing
-- signed_at), so there is nothing to back-fill.
--
-- ⚠ NOT ON THE MONEY SPINE. A declined envelope moves no term, no rent and no CAM — by
-- 0085's rule, only APPLYING a signed document moves a figure, and this document was never
-- signed. Nothing here touches a view, a policy or an invoice.

alter table public.signature_envelopes
  add column if not exists declined_at timestamptz;

comment on column public.signature_envelopes.declined_at is
  'When the counterparty refused to sign, written by sign-envelope alongside status=declined '
  'and declined_reason. Null on rows declined before 0096 — the dashboard alert prints the '
  'reason without a date rather than guessing one off updated_at.';
