-- Slice 5c — the closing statement gets somewhere to live.
--
-- A landlord who bought a building in 2014 cannot reconstruct its basis from a bank
-- statement, and Amlak has never asked for the one document that carries it. The ALTA
-- Settlement Statement (formerly HUD-1) states the purchase price, the closing date and
-- every settlement charge — read ONCE per property, forever.
--
-- ⚠ THIS MIGRATION DELIBERATELY ADDS NO COLUMNS TO `properties`, WHICH REVERSES THE
-- PLAN'S OWN ROUND-11 ROW ("first real properties columns"). Round 9 settled the
-- question the other way and its reasoning holds: the building is an asset exactly as
-- the roof is — one cost, one in-service date, one land allocation — so it belongs in
-- `fixed_assets` with everything else. That keeps ONE depreciation rule for everything.
-- A `properties.purchase_price` would be a SECOND source for a figure the building asset
-- already carries, and the two would drift the first time either was edited. Same for an
-- `acquired_on`, which is the building's `placed_in_service` under another name.
--
-- So the only thing this round needs from the schema is somewhere to keep the DOCUMENT.
-- A closing statement belongs to the property, not to any one of the three or four
-- assets a single reading creates, and picking one of them arbitrarily would make the
-- other two unreachable from the paper that produced them.
--
-- Non-destructive: widens one CHECK by a single member. Every existing row still passes.

alter table public.documents drop constraint if exists documents_entity_type_check;

alter table public.documents
  add constraint documents_entity_type_check
  check (entity_type in (
    'lease', 'addendum', 'insurance_policy', 'service_contract',
    'statement_import', 'annual_report',
    -- New: a document about the property itself. The closing statement is the first,
    -- and a deed, survey or appraisal would land here too.
    'property'));
