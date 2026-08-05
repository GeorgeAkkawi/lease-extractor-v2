-- 0094 — is the landlord named as ADDITIONAL INSURED on the vendor's policy?
--
-- George, 2026-08-05: *"the contracts should also be read to see if the user is listed as
-- additional insured and if they are not the same email as the insurance template should be
-- added as a button."*
--
-- THE SAME QUESTION THE INSURANCE VAULT ALREADY ASKS, pointed the other way. A tenant's
-- certificate is checked for it (insurance_policies.additional_insured, 0032) because a
-- tenant who injures someone on the premises drags the landlord in. A VENDOR is the larger
-- exposure of the two and was never checked at all: a plough operator who clips a car, a
-- contractor whose employee falls off a roof — the claim lands on the owner, and without the
-- additional-insured endorsement the vendor's policy does not answer for it.
--
-- ⚠ THREE-STATE, NOT TWO. Nullable boolean, and null is load-bearing: it means "the document
-- does not say", which is NOT the same as "no". The warning and the request-endorsement
-- button fire only on an explicit false — an unread contract must not accuse a vendor of
-- being uninsured, and a contract Amlak has never seen must not look compliant either.
-- Mirrors insurance_policies.additional_insured, which is nullable for the same reason.
--
-- ⚠ NOT ON THE MONEY SPINE. This column touches no CAM line item, no cam_total, no share and
-- no invoice. It is read by the contract row's warning line, the letter it drafts, and
-- nothing else — deliberately, so a rewritten insurance clause can never move a bill.

alter table public.service_contracts
  add column if not exists additional_insured boolean;

comment on column public.service_contracts.additional_insured is
  'Does this contract require the vendor to name the owner as additional insured (and say so)? '
  'TRUE = stated, FALSE = the contract is read and does not require it, NULL = not stated / not read. '
  'Null is not false: the warning and the endorsement-request letter fire only on an explicit false.';
