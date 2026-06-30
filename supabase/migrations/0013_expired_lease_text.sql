-- 0013_expired_lease_text.sql
-- Carry the cached lease text onto the archive record so a finished lease can
-- still be opened and queried by the AI assistant from History (full history is
-- preserved even after the tenant is removed/renewed/terminated).
alter table expired_leases
  add column if not exists lease_text text;
