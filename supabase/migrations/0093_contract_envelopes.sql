-- 0093 — an envelope can belong to a SERVICE CONTRACT, not only to a lease.
--
-- THE GAP, and it is one column. 0085 gave the app e-signature, but
-- signature_envelopes.lease_id is `not null references leases`, so an envelope has only ever
-- had one kind of home. George, 2026-08-05: *"on the contracts tab next to add contract it
-- should say send one for signature like it does on the lease addendums and riders. none of
-- that is there so i cant send one for signature."* The button was never the missing part —
-- there was nowhere to file the record.
--
-- ⚠ NOTHING ELSE IN THE FEATURE IS LEASE-SHAPED, which is why this is additive rather than a
-- second table. `sign-envelope` (the unauthenticated tenant/vendor side) reads no lease at
-- all; `countersign-envelope` SELECTS lease_id and never uses it, building its sender name
-- from property_id — which a service contract has. So one nullable column and one new FK
-- carry a vendor through the identical send → sign → countersign → executed machine.
--
-- ⚠ EXACTLY ONE OWNER, enforced. An envelope that pointed at both a lease and a contract
-- would render on two cards and be deleted by two cascades. The check below is satisfied by
-- every row that exists today by construction: lease_id was NOT NULL before this migration
-- and contract_id does not exist yet, so `(true) <> (false)` holds for all of them. That is
-- what makes adding a CHECK to a live table safe HERE and nowhere else in this schema —
-- the service_contracts enums deliberately carry no CHECK for exactly the opposite reason.
--
-- ⚠ NOTHING ON THE MONEY SPINE MOVES. Like 0085, this books nothing: an executed contract
-- envelope changes no fee, no CAM line item and no invoice. Reading the signed document and
-- applying its terms is a separate, explicitly confirmed action in application code
-- (applyNewContractTerms), and that is the step that carries CAM through.

alter table public.signature_envelopes
  alter column lease_id drop not null;

alter table public.signature_envelopes
  add column if not exists contract_id uuid references public.service_contracts (id) on delete cascade;

-- The contracts tab reads every envelope for one contract, newest first — the twin of
-- signature_envelopes_lease_idx.
create index if not exists signature_envelopes_contract_idx
  on public.signature_envelopes (contract_id, sent_at desc);

do $$ begin
  alter table public.signature_envelopes
    add constraint ck_env_one_owner
    check ((lease_id is not null) <> (contract_id is not null));
exception when duplicate_object then null; end $$;

-- `purpose` decides where an executed copy files itself. A contract is its own answer: the
-- executed copy IS the contract, so there is no extension/replacement/other question to ask
-- and the send dialog does not ask one.
alter table public.signature_envelopes drop constraint if exists signature_envelopes_purpose_check;
alter table public.signature_envelopes
  add constraint signature_envelopes_purpose_check
  check (purpose in ('extension', 'new_lease', 'other', 'service_contract'));

comment on column public.signature_envelopes.contract_id is
  'The service contract this document was sent out for, when it is not a lease document. '
  'Exactly one of lease_id / contract_id is set (ck_env_one_owner).';
