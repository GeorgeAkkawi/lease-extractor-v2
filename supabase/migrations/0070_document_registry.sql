-- 0070_document_registry.sql
-- "Keep every uploaded document" (George, 2026-07-30) — plus the rider dates that
-- make a rider readable as a period rather than just a signing date.
--
-- Everything here is ADDITIVE and idempotent: one new table, three nullable
-- columns, two guarded backfills that only ever write where the target is null,
-- and one widened storage MIME allowlist. Nothing is dropped, nothing is
-- rewritten, and re-running the file is a no-op.
--
-- Why a registry table rather than more storage_path columns: five record types
-- (lease, rider, insurance policy, service contract, statement import, annual
-- report) all upload files, and only leases have anything resembling version
-- history today — and lease_files is really about the EXTRACTION (it holds
-- extraction_raw, and leases.lease_file_id points at it), not about keeping the
-- document. One registry means one component renders every list, one query finds
-- every orphan, and a file cannot exist without a row naming it.
--
-- lease_files and insurance_documents STAY, unchanged, doing their existing jobs.
-- The single storage_path columns stay too: they remain "the current file", so
-- nothing that reads them today changes behaviour.

-- ===========================================================================
-- 1) The registry
-- ===========================================================================
create table if not exists public.documents (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references auth.users (id) on delete cascade,
  entity_type  text not null check (entity_type in (
                 'lease', 'addendum', 'insurance_policy', 'service_contract',
                 'statement_import', 'annual_report')),
  -- Deliberately NULLABLE: the lease importer uploads the file before a lease
  -- row exists. The review screen attaches it on save; cancelling deletes both
  -- the row and the file.
  entity_id    uuid,
  storage_path text not null,
  filename     text,
  bytes        bigint,
  mime         text,
  label        text,
  note         text,
  created_at   timestamptz not null default now(),
  constraint ck_doc_path_len  check (char_length(storage_path) <= 1024),
  constraint ck_doc_name_len  check (filename is null or char_length(filename) <= 400),
  constraint ck_doc_label_len check (label is null or char_length(label) <= 200),
  constraint ck_doc_note_len  check (note is null or char_length(note) <= 2000)
);

create index if not exists documents_entity_idx on public.documents (entity_type, entity_id);
create index if not exists documents_owner_idx  on public.documents (owner_id);

alter table public.documents enable row level security;

drop policy if exists owner_all on public.documents;
create policy owner_all on public.documents for all
  using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Same aal2 gate every other owner-scoped table carries (0052/0056). Dormant for
-- a user with no verified MFA factor, so nothing changes until 2FA is enrolled.
drop policy if exists require_aal2 on public.documents;
create policy require_aal2 on public.documents
  as restrictive to authenticated using (
    (select auth.jwt() ->> 'aal') = 'aal2'
    or not public.user_has_verified_mfa()
  );

-- ===========================================================================
-- 2) Riders learn the period they GOVERN, not just the day they were signed
-- ===========================================================================
-- lease_addendums has carried only amendment_date (the signing date) since 0021.
-- George: "input the dates of the rider" — a from/to pair, editable, pre-filled
-- by the extractor.
alter table public.lease_addendums add column if not exists effective_from date;
alter table public.lease_addendums add column if not exists effective_to   date;

-- ===========================================================================
-- 3) Backfill the rider dates from each rider's OWN cached extraction
-- ===========================================================================
-- Non-destructive and already derivable — the extractor has been reading these into
-- extraction_raw all along, they simply had no column to land in. Guarded on "is
-- null" so a hand-entered date is never overwritten.
--
-- ROW BY ROW, each cast in its own exception block — NOT a set-based UPDATE with a
-- regex guard in the WHERE clause. The regex only proves the FORMAT; a rider can
-- print a calendar-impossible date, and this codebase has a live one: the Denny's
-- rider's extraction_raw carries new_termination_date "2033-04-31" (the document
-- literally says "April 31, 2033" — see the 2026-07-25 entry, which is why
-- isoDateOrNull now round-trips every date the app writes). A WHERE-clause guard
-- cannot save the batch, because evaluating it requires executing the very cast
-- that raises — and Postgres does not promise left-to-right AND evaluation anyway.
-- Isolating each row means one impossible date is left null (the landlord types it)
-- instead of aborting the migration on every re-run.
do $backfill_dates$
declare
  r record;
begin
  for r in
    select id,
           extraction_raw ->> 'new_base_rent_effective_date' as raw_from,
           extraction_raw ->> 'new_termination_date'          as raw_to
      from public.lease_addendums
     where effective_from is null or effective_to is null
  loop
    if r.raw_from ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        update public.lease_addendums set effective_from = r.raw_from::date
         where id = r.id and effective_from is null;
      exception when others then null;   -- impossible date: leave it blank
      end;
    end if;
    if r.raw_to ~ '^\d{4}-\d{2}-\d{2}$' then
      begin
        update public.lease_addendums set effective_to = r.raw_to::date
         where id = r.id and effective_to is null;
      exception when others then null;
      end;
    end if;
  end loop;
end
$backfill_dates$;

-- A rider with no stated start still has one in practice: the day it was signed.
update public.lease_addendums
   set effective_from = amendment_date
 where effective_from is null
   and amendment_date is not null
   and effective_to is not null;

-- ===========================================================================
-- 4) Backfill the registry from the leases that already have a file
-- ===========================================================================
-- Every lease imported with a document points at a lease_files row that holds its
-- storage_path. Derivable, so this loses nothing and invents nothing: exactly one
-- documents row per lease that has a file, skipped if one already exists.
insert into public.documents (owner_id, entity_type, entity_id, storage_path, filename, created_at)
select lf.owner_id, 'lease', l.id, lf.storage_path, left(lf.original_filename, 400), lf.created_at
  from public.leases l
  join public.lease_files lf on lf.id = l.lease_file_id
 where lf.storage_path is not null
   and not exists (
     select 1 from public.documents d
      where d.entity_type = 'lease' and d.entity_id = l.id and d.storage_path = lf.storage_path
   );

-- Riders that already carry a file get their registry row too.
insert into public.documents (owner_id, entity_type, entity_id, storage_path, filename, created_at)
select a.owner_id, 'addendum', a.id, a.storage_path, left(a.label, 400), a.created_at
  from public.lease_addendums a
 where a.storage_path is not null
   and not exists (
     select 1 from public.documents d
      where d.entity_type = 'addendum' and d.entity_id = a.id and d.storage_path = a.storage_path
   );

-- ===========================================================================
-- 5) An archived tenant keeps their lease document
-- ===========================================================================
-- archiveLease already preserves lease_text and the billing history into
-- expired_leases, and History offers "Open & ask" on a former tenant. Carrying the
-- path across means the original document stays openable too — the alternative
-- (deleting it with the lease) would be the one genuinely lossy move in this round.
alter table public.expired_leases add column if not exists storage_path text;

-- ===========================================================================
-- 6) Storage: allow the CSV bank statements that were being silently dropped
-- ===========================================================================
-- The CSV import lane calls uploadDoc(file).catch(() => null) with a comment
-- saying the file is kept — but 'csv' was in neither the client allowlist nor the
-- bucket's, so validateUploadFile threw and the catch swallowed it. Every CSV
-- statement ever imported was discarded. Both allowlists are widened together.
update storage.buckets
   set allowed_mime_types = array[
         'application/pdf',
         'image/png',
         'image/jpeg',
         'image/webp',
         'image/gif',
         'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
         'text/csv',
         'application/csv',
         'application/vnd.ms-excel'   -- what many browsers report for a .csv
       ]
 where id = 'lease-documents';
