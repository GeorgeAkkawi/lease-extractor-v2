-- 0086 — switch the new E-signature module ON for accounts that had already chosen.
--
-- The `announcements` migration (0084) with one key changed, exactly as its own header and
-- CLAUDE.md §4 instruct. The reasoning is unchanged and worth restating in one line, because
-- the next module will need this file too:
--
--   `user_preferences.enabled_features` is null for a never-chosen account and an EXPLICIT
--   ARRAY once the landlord touches the Features switchboard. isFeatureOn (features.js)
--   reads null as "everything on" and an array as "exactly this set" — so a key merely
--   APPENDED to the FEATURES registry is OFF for every account that ever saved a choice,
--   silently. The demo cannot catch it: it seeds no user_preferences row, so it runs the
--   null path and shows the module while production hides it.
--
-- ⚠ WHY ON RATHER THAN OFF. An account that chose before the module existed never made a
-- decision about it, so it gets the same default a brand-new account gets: on. Turning it
-- off afterwards is one click in Settings; never discovering it exists is not.
--
-- NON-DESTRUCTIVE AND IDEMPOTENT. Only APPENDS, only to rows that already made a choice, and
-- only where the key is missing — a null stays null, an explicit off-switch set later is
-- never overwritten by a re-run, and no other preference key is touched.

update public.user_preferences
   set enabled_features = enabled_features || '["esign"]'::jsonb
 where enabled_features is not null
   and jsonb_typeof(enabled_features) = 'array'
   and not jsonb_exists(enabled_features, 'esign');
