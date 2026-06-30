-- 0009_corp_sender.sql
-- Move the email "sender identity" from a single owner-level business profile to
-- each corporation, so landlords can send from a different address per entity.
-- The corporation's name is the letterhead company name; add address + contacts.

alter table corporations
  add column if not exists address text,
  add column if not exists contact_email text,
  add column if not exists contact_phone text;

-- The owner-level table from 0008 is superseded by per-corporation fields.
drop table if exists business_profile;
