-- 0012_lease_text_and_no_renewal.sql
-- (1) Manual "no renewal option" flag: the landlord confirms a lease genuinely
--     has no renewal clause (e.g. AI found none), so lease-ending alerts can
--     explicitly warn "ending — no renewal on file" within the reminder windows.
-- (2) Cached plain-text copy of the lease, saved once at intake. The per-tenant
--     AI assistant answers questions against this cached text (cheap: no PDF
--     re-parsing, small model + prompt caching) instead of re-reading the file.
alter table leases
  add column if not exists no_renewal_option boolean not null default false,
  add column if not exists lease_text text;
