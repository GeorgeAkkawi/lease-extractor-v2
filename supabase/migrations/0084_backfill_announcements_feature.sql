-- 0084 — switch the new Announcements module ON for accounts that had already chosen.
--
-- THE BUG THIS FIXES, and it will bite again if nobody reads this. `user_preferences.
-- enabled_features` is null for a never-chosen account and an EXPLICIT ARRAY once the
-- landlord touches the Features switchboard. `isFeatureOn` (src/lib/features.js) reads
-- null as "everything on" and an array as "exactly this set" — so the moment a key is
-- appended to the FEATURES registry, it is **OFF for every account that has ever saved a
-- choice**, silently, with no way to discover it except stumbling on the Settings toggle.
--
-- That is what happened on 2026-08-04: `announcements` shipped, George's account carried
-- ["insurance","contracts","ledger"] saved on 2026-07-31, and the button simply never
-- rendered for him. The demo showed it fine because the demo seeds no preferences row at
-- all (null ⇒ everything on) — which is exactly why the browser verification missed it.
--
-- ⚠ THE AMBIGUITY IS IN THE DATA MODEL, NOT THIS MIGRATION. A key absent from the stored
-- array means EITHER "the landlord turned it off" OR "it didn't exist when he chose", and
-- the array alone cannot tell them apart. So this cannot be fixed once in code — it has to
-- be fixed per module, at the moment the module ships. **Every future entry appended to
-- FEATURES must ship a migration exactly like this one** (see the comment above the
-- FEATURES array in src/lib/features.js and CLAUDE.md §4).
--
-- ⚠ WHY ON RATHER THAN OFF. An account that chose before the module existed never made a
-- decision about it, so it gets the same default a brand-new account gets: on. Turning it
-- off afterwards is one click in Settings; never discovering it exists is not.
--
-- NON-DESTRUCTIVE AND IDEMPOTENT. It only ever APPENDS, only to rows that already made a
-- choice, and only where the key is missing — a null stays null (still "everything on"),
-- an explicit off-switch set later is never overwritten by a re-run, and no other
-- preference key is touched.

update public.user_preferences
   set enabled_features = enabled_features || '["announcements"]'::jsonb
 where enabled_features is not null
   and jsonb_typeof(enabled_features) = 'array'
   and not jsonb_exists(enabled_features, 'announcements');
