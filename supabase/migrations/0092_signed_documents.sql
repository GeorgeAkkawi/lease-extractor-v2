-- 0092 — a stored file can be designated THE SIGNED COPY.
--
-- George, 2026-08-05: *"i just meant that after the contract is signed the signed copy should
-- be saved as a pdf in the contracts tab - that should be the same of the leases in the
-- respective tab as well."*
--
-- One nullable column on `documents` (0070), which is already the single registry every
-- uploaded file for every record type files into — so this serves contracts, leases, riders
-- and insurance certificates at once, which is precisely the "and the same on the leases"
-- half of the ask. No new table, no new storage bucket, no second row anywhere.
--
-- ⚠ WHY NOT A SECOND `documents` ROW POINTING AT THE ENVELOPE'S EXECUTED PDF. That was the
-- obvious design and it is wrong in both directions: deleteEnvelope() sweeps the storage
-- object, so a documents row on the same path would survive and offer "Open" on a file that
-- is gone; and symmetrically deleteDocumentsFor('lease', …) would delete the object out from
-- under a live envelope. Two rows, one object, two owners. Instead countersign-envelope
-- stamps signed_at on the row it ALREADY inserts, and the envelope stays the single owner of
-- its own file.
--
-- ⚠ DELIBERATELY NOT UNIQUE PER RECORD. An amended contract legitimately has an original
-- signed copy AND a signed amendment; a lease has an executed lease and an executed rider.
-- The UI sorts signed copies first and badges each one; it does not pretend there is only one.
--
-- Additive, idempotent, non-destructive.

alter table public.documents
  add column if not exists signed_at timestamptz;

comment on column public.documents.signed_at is
  'When this file was executed, if it IS the signed copy. Null = an ordinary saved copy. '
  'Set automatically by countersign-envelope on the executed PDF it files, or by hand via '
  'markDocumentSigned(). Not unique per record on purpose — an amended agreement has more '
  'than one signed document.';

-- Partial index: the only query is "the signed copies for this record", and the vast
-- majority of rows are ordinary saved copies.
create index if not exists documents_signed_idx
  on public.documents (entity_type, entity_id, signed_at desc)
  where signed_at is not null;
