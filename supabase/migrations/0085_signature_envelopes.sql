-- 0085 — e-signature: send a document out from Amlak and get it back signed.
--
-- THE GAP. Every lease and rider in this app arrives ALREADY signed — printed, signed on
-- paper, scanned, and uploaded (lease_addendums.storage_path, 0021). Nothing here has ever
-- sent a document OUT. There is no record of who is waiting on what, and an executed copy
-- has to be walked back in by hand.
--
-- ⚠ THIS IS THE FIRST FEATURE IN THE APP WITH AN UNAUTHENTICATED READER. Every other table
-- is reached only through a logged-in session (owner_all + require_aal2, 0052). A tenant
-- signing a lease has no account and never will, so the `sign-envelope` edge function reads
-- these three tables with the SERVICE ROLE, bypassing RLS. Everything below is shaped around
-- making that safe:
--
--   1. THE TOKEN IS NEVER STORED. envelope_signers.token_hash holds sha256(token) only. The
--      raw 32-byte token exists exactly twice: in the link that was emailed, and in the
--      tenant's address bar. A leaked database backup yields no working links — the same
--      discipline as a password digest, and the reason there is no `token` column here to
--      be tempted by.
--   2. THE TOKEN IS THE ONLY SELECTOR. token_hash is UNIQUE, so the function looks a signer
--      up by hash and nothing else. It accepts no envelope id, no lease id and no other
--      enumerable parameter, which is why none of them can be walked.
--   3. THE ROW CARRIES ITS OWN LIMITS. expires_at and status live on the envelope, so
--      "expired" and "already finished" are answerable from the single row the token found,
--      with no second lookup that could widen the query.
--
-- WHAT IS DELIBERATELY NOT HERE. No rent, no square footage, no financial column of any
-- kind. An envelope points at a lease; it never copies a figure out of one. That is what
-- lets the public function return an envelope row nearly verbatim without leaking money
-- data — there is none in it to leak.
--
-- envelope_events IS THE PRODUCT, NOT A LOG. ESIGN/UETA make an electronic signature
-- enforceable on four things: intent, consent, attribution and retention. Attribution
-- (UETA §9 — "may be proved in any manner, including a showing of the efficacy of any
-- security procedure") is the one that needs evidence, and this table IS that evidence:
-- every view, consent and signature with its timestamp, IP and user agent, printed onto the
-- Certificate of Completion page of the executed PDF. Rows are append-only by convention —
-- nothing in the app updates or deletes one.
--
-- doc_sha256 IS THE TAMPER SEAL. Hashed at send from the exact bytes the tenant is shown,
-- stated on the certificate. It is what makes "this is the document they signed" provable
-- rather than asserted.
--
-- ⚠ NOTHING ON THE MONEY SPINE MOVES. No view, no RPC, no trigger beyond the standard
-- updated_at, and not one stored dollar can change as a result of this migration. Applying
-- a signed document to a lease is a separate, explicit, confirmed action that lives in
-- application code — an envelope reaching 'executed' books nothing by itself.

-- ===========================================================================
-- 1) The envelope — one document, out for signature
-- ===========================================================================
create table if not exists public.signature_envelopes (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid not null references auth.users (id) on delete cascade,
  lease_id          uuid not null references public.leases (id) on delete cascade,
  -- Denormalized from the lease so the alert feed and the property views can filter
  -- without a join, exactly as lease_addendums' callers do.
  property_id       uuid not null references public.properties (id) on delete cascade,
  -- Set when the envelope was started from a renewal option row, so applying the executed
  -- copy can settle that option. `set null` — deleting the option must not delete the
  -- record of a document that was actually signed.
  renewal_option_id uuid references public.renewal_options (id) on delete set null,
  -- What the document IS, which decides where the executed copy files itself:
  --   extension / other → a lease_addendums row (it joins the Riders list)
  --   new_lease         → held against the envelope until the landlord decides whether it
  --                       updates this lease's terms or replaces the record outright
  purpose           text not null default 'other'
                      check (purpose in ('extension', 'new_lease', 'other')),
  title             text not null,
  -- The unsigned document, in the private lease-documents bucket. Never handed to the
  -- tenant as a path — the public function mints a 120-second signed URL per view.
  storage_path      text not null,
  filename          text,
  -- sha256 of the exact bytes above, hex. See the header.
  doc_sha256        text not null,
  -- The landlord's covering note in the email. Prose, never a figure.
  message           text,
  status            text not null default 'sent'
                      check (status in ('sent', 'signed', 'executed', 'declined', 'voided', 'expired')),
  -- A hard stop the public function checks before it will show anything.
  expires_at        timestamptz not null,
  sent_at           timestamptz not null default now(),
  signed_at         timestamptz,
  countersigned_at  timestamptz,
  executed_at       timestamptz,
  declined_reason   text,
  -- Set when the landlord pushes an executed document's terms into the lease. Written by
  -- the Phase 2 apply step and read by nothing else; until it is set, an executed envelope
  -- is a signed document sitting in a drawer, and the app says so. Deliberately separate
  -- from `status` — "signed by both parties" and "acted on" are different facts, and
  -- collapsing them would make an unapplied extension look finished.
  applied_at        timestamptz,
  -- The finished article: the document plus both signatures plus the certificate.
  executed_path     text,
  certificate_path  text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint ck_env_title_len  check (char_length(title) <= 300),
  constraint ck_env_path_len   check (char_length(storage_path) <= 1024),
  constraint ck_env_msg_len    check (message is null or char_length(message) <= 5000),
  constraint ck_env_reason_len check (declined_reason is null or char_length(declined_reason) <= 2000)
);

-- The lease page reads every envelope for one lease, newest first.
create index if not exists signature_envelopes_lease_idx
  on public.signature_envelopes (lease_id, sent_at desc);
-- The alert sweep reads every open envelope for one owner.
create index if not exists signature_envelopes_owner_status_idx
  on public.signature_envelopes (owner_id, status);

-- ===========================================================================
-- 2) The signers — one tenant row (holds the link) + one landlord row
-- ===========================================================================
-- Two rows per envelope today. The table shape allows more because a lease signed by two
-- partners is ordinary; the UI collects one tenant signer and that is a UI limit, not a
-- schema one.
create table if not exists public.envelope_signers (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  envelope_id  uuid not null references public.signature_envelopes (id) on delete cascade,
  role         text not null check (role in ('tenant', 'landlord')),
  name         text not null,
  email        text,
  -- sha256(link token), hex. NULL on the landlord row — he signs inside the app, under his
  -- own session, and must never have a bearer link to his own document. UNIQUE so the
  -- public function's lookup is an exact index hit on one row.
  token_hash   text unique,
  -- The four facts a certificate needs about a signature.
  consent_at   timestamptz,
  signed_at    timestamptz,
  typed_name   text,
  signature_path text,
  ip           text,
  user_agent   text,
  created_at   timestamptz not null default now(),
  constraint ck_sgn_name_len check (char_length(name) <= 200),
  constraint ck_sgn_ua_len   check (user_agent is null or char_length(user_agent) <= 500)
);

create index if not exists envelope_signers_envelope_idx
  on public.envelope_signers (envelope_id);

-- ===========================================================================
-- 3) The audit trail — what the Certificate of Completion is printed from
-- ===========================================================================
create table if not exists public.envelope_events (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  envelope_id  uuid not null references public.signature_envelopes (id) on delete cascade,
  at           timestamptz not null default now(),
  kind         text not null check (kind in (
                 'created', 'sent', 'viewed', 'consented', 'signed',
                 'countersigned', 'executed', 'declined', 'voided', 'reminded')),
  actor        text not null default 'system' check (actor in ('landlord', 'tenant', 'system')),
  ip           text,
  user_agent   text,
  detail       jsonb,
  constraint ck_evt_ua_len check (user_agent is null or char_length(user_agent) <= 500)
);

-- Always read as one envelope's history, oldest first.
create index if not exists envelope_events_envelope_idx
  on public.envelope_events (envelope_id, at);

-- ===========================================================================
-- 4) Triggers + RLS — the standard owner-table treatment on all three
-- ===========================================================================
drop trigger if exists trg_signature_envelopes_updated on public.signature_envelopes;
create trigger trg_signature_envelopes_updated
  before update on public.signature_envelopes
  for each row execute function set_updated_at();

alter table public.signature_envelopes enable row level security;
alter table public.envelope_signers    enable row level security;
alter table public.envelope_events     enable row level security;

do $$ begin
  create policy owner_all on public.signature_envelopes
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy owner_all on public.envelope_signers
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy owner_all on public.envelope_events
    for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());
exception when duplicate_object then null; end $$;

-- Dormant until a user enrols an authenticator (0052), like every other owner table.
do $$ begin
  create policy require_aal2 on public.signature_envelopes
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy require_aal2 on public.envelope_signers
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;

do $$ begin
  create policy require_aal2 on public.envelope_events
    as restrictive for all
    using ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa())
    with check ((select auth.jwt() ->> 'aal') = 'aal2' or not public.user_has_verified_mfa());
exception when duplicate_object then null; end $$;

-- ===========================================================================
-- 5) The document registry learns about envelopes
-- ===========================================================================
-- Same drop-and-re-add shape 0081 used to add its own types. An executed copy is a real
-- saved file and belongs in the registry with every other one, so storage sweeps and the
-- documents list can see it.
alter table public.documents drop constraint if exists documents_entity_type_check;
alter table public.documents
  add constraint documents_entity_type_check
  check (entity_type in (
    'lease', 'addendum', 'insurance_policy', 'service_contract',
    'statement_import', 'annual_report', 'property', 'envelope'));

comment on table public.signature_envelopes is
  'One document sent out for signature. Reached by an UNAUTHENTICATED tenant through the '
  'sign-envelope edge function (service role), keyed ONLY by sha256 of the emailed token '
  'held in envelope_signers.token_hash. Deliberately holds no financial column.';

comment on table public.envelope_events is
  'Append-only audit trail per envelope. Printed onto the Certificate of Completion page of '
  'the executed PDF — this is the ESIGN/UETA attribution evidence, not a debug log.';
