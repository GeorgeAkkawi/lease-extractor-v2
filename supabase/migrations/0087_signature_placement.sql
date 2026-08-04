-- 0087 — where on the page each signature actually goes.
--
-- THE GAP 0085 LEFT. Phase 1 appended a SIGNATURES page to the end of the executed PDF,
-- because there was nowhere else to put the mark. That is legally sound — UETA §2(8) asks
-- only that a signature be "attached to or logically associated with" the record, and the
-- certificate page carries the document's SHA-256, which is a stronger association than ink
-- (it proves the bytes never moved). But a lease whose signature lines are BLANK looks
-- unsigned to a lender, a buyer, a title company, and to the landlord himself two years on.
-- George, 2026-08-04: *"they arent signing the actual document just a box that says that so
-- there needs to be a way to prove they signed it… drag and drop signature feature? on the
-- pdf on the tenants side that automatically copies it down and send it back as a real
-- signature on the actual pdf document?"*
--
-- WHY THE SIGNER PLACES IT, NOT THE SENDER. DocuSign's model is that the sender pre-places
-- "sign here" tabs and the signer clicks one. George's is that the signer drags their own
-- mark onto the line, and his is the stronger of the two: intent to sign is the FIRST thing
-- ESIGN and UETA ask for, and deliberately placing your own signature on the signature line
-- demonstrates it far better than ticking a box beside an appended page. It is the closest
-- digital equivalent of putting pen to that line.
--
-- ⚠ PDF POINTS, BOTTOM-LEFT ORIGIN — NOT PIXELS, NOT PERCENTAGES. A signature dropped on a
-- phone and one dropped on a desktop must land in the same place, so nothing here may depend
-- on the viewer's scale. The browser converts on drop with pdfjs's own
-- `viewport.convertToPdfPoint()`, which already accounts for scale AND page rotation.
--
-- ⚠ AND THE ONE PLACE THE TWO LIBRARIES DISAGREE, recorded here because it will look correct
-- on every test PDF and be wrong on a real scanned lease: pdf.js reports points through a
-- viewport that has ALREADY applied the page's /Rotate, while pdf-lib draws in the page's
-- UNROTATED space. A page with getRotation().angle !== 0 therefore needs the stored point
-- transformed back before stamping. That transform lives in src/lib/signPlacement.js and is
-- unit-tested at 0/90/180/270.
--
-- ⚠ ALL FOUR COLUMNS ARE NULLABLE, AND THAT IS LOAD-BEARING. An unplaced signature is NOT an
-- error: the executed PDF falls back to the appended SIGNATURES page exactly as it does
-- today. Signing must never be blocked because someone didn't drag anything — a tenant on a
-- phone with a document that won't render still has to be able to sign.
--
-- Nothing on the money spine moves. Four additive columns on one table.

alter table public.envelope_signers
  -- 1-based page number, matching pdf.js's getPage(n) and pdf-lib's getPages()[n-1].
  add column if not exists place_page int,
  -- The BOTTOM-LEFT corner of the signature box, in PDF points from the page's bottom-left.
  add column if not exists place_x numeric,
  add column if not exists place_y numeric,
  -- Width in points. The height is NOT stored — it is derived from the signature image's own
  -- aspect ratio at stamp time, so a re-drawn signature can never come out squashed.
  add column if not exists place_w numeric;

-- A page number that isn't a real page would silently stamp nothing (or throw at render).
-- Refuse it at the door; null still means "not placed".
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.envelope_signers'::regclass
      and conname = 'ck_sgn_place_page'
  ) then
    alter table public.envelope_signers
      add constraint ck_sgn_place_page
      check (place_page is null or place_page >= 1);
  end if;
end $$;

comment on column public.envelope_signers.place_x is
  'Signature box bottom-left, in PDF POINTS from the page bottom-left (never pixels — the '
  'placement must survive being made on a phone and stamped on a server). Height is derived '
  'from the image aspect ratio at stamp time. Null = not placed; the executed PDF falls back '
  'to an appended signature page. See src/lib/signPlacement.js for the rotation transform.';
