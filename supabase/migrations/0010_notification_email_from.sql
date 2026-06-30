-- 0010_notification_email_from.sql
-- Remember which corporation address a renewal/escalation email should default to
-- as the "send from" account, so the send-time chooser can pre-select it.
alter table notifications
  add column if not exists email_from text;
