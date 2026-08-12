-- 0100 — retire the entity ledger into the expense buckets.
--
-- George, 2026-08-12: "does stuff like a distribution just go under an expense
-- categorized as distribution … i think when we were making the accounting part it got
-- way too in depth and i want to remove some of the clutter."
--
-- So `entity_ledger` (0077) is retired. Its three kinds move to homes that already
-- existed, and the app's "Owner & entity money" panel goes with it:
--
--   draw          → a NOT-BILLED cam_line_items row, bucket named after the person,
--                   whose expense_buckets record carries category = 'distribution'
--   cost          → a NOT-BILLED cam_line_items row keeping its own category
--   contribution  → NOTHING is written. Money the landlord puts in has no amount-bearing
--                   home any more; it files as a `transfer` disposition, which records
--                   the bank line and counts it nowhere. See the note at the bottom.
--
-- ⚠ WHY THIS CANNOT MOVE A TENANT'S BILL, and it is by construction rather than by care.
-- Every row written here is `billable = false`, and syncCamTotal (src/lib/api.js) sums
-- ONLY `billable is not false` into expense_records.cam_total. So nothing reaches
-- cam_total → v_property_totals → v_tenant_shares → a stored invoice. No resync is
-- needed and none is triggered; a property's NOI and Total expenses read identically
-- before and after this migration. That is the property that made the whole retirement
-- safe, and it is worth re-checking by hand on one property after applying.
--
-- ⚠ NON-DESTRUCTIVE AND REVERSIBLE. This COPIES. `entity_ledger` keeps every row, keeps
-- its RLS and keeps its indexes — nothing reads it once the app ships, but the table is
-- the rollback. Dropping it is a later decision, taken deliberately, not a side effect
-- of a declutter.

do $$
declare
  v_moved     int := 0;
  v_buckets   int := 0;
  v_skipped   int := 0;
  v_contrib   int := 0;
begin
  -- ── 1. The bucket records that carry the category ─────────────────────────────────
  --
  -- A cam_line_items row has no category column: the category lives on expense_buckets,
  -- keyed case-insensitively by label (0075). So a distribution needs a bucket named
  -- after whoever took it — `party` (0098) when the landlord named them, else the row's
  -- own label — and that bucket is what says `distribution`.
  --
  -- ON CONFLICT DO NOTHING rather than DO UPDATE: if a bucket of that name already
  -- exists, the landlord's own category on it outranks anything inferred here. That is
  -- also what makes this half idempotent.
  --
  -- DISTINCT ON with a matching ORDER BY, because two entity rows can share a payee and
  -- the unique index would otherwise reject the batch. Newest first, so where a payee's
  -- rows disagree about the category the most recent answer is the one kept.
  insert into public.expense_buckets (owner_id, label, category, billable)
  select distinct on (e.owner_id, lower(btrim(coalesce(nullif(btrim(e.party), ''), nullif(btrim(e.label), ''), 'Owner distribution'))))
         e.owner_id,
         coalesce(nullif(btrim(e.party), ''), nullif(btrim(e.label), ''), 'Owner distribution'),
         case when e.kind = 'draw' then 'distribution' else e.category end,
         false
    from public.entity_ledger e
   where e.kind in ('draw', 'cost')
     and e.property_id is not null
   order by e.owner_id,
            lower(btrim(coalesce(nullif(btrim(e.party), ''), nullif(btrim(e.label), ''), 'Owner distribution'))),
            e.created_at desc
  on conflict (owner_id, lower(btrim(label))) do nothing;
  get diagnostics v_buckets = row_count;

  -- ── 2. The money itself ───────────────────────────────────────────────────────────
  --
  -- `paid_date` takes txn_date, so the line keeps the day the bank printed on it, and
  -- `import_id` rides along so a statement's ↩ Undo still reverses its own delta.
  --
  -- ⚠ THE RE-RUN GUARD IS A NATURAL KEY, not a marker column: cam_line_items has no
  -- `note`, and adding one to a core billing table to carry a one-time flag is a worse
  -- trade than this. (property, label, amount, date, not-billed) identifies a migrated
  -- row well enough that re-running writes nothing. What it CANNOT tell apart is two
  -- genuinely identical distributions — same payee, same amount, same day — of which it
  -- would copy only one. That is a real limit, so the notice below reports what moved
  -- and `entity_ledger` is kept intact to check against.
  insert into public.cam_line_items
         (owner_id, property_id, year, kind, label, amount, billable, paid_date, import_id)
  select e.owner_id,
         e.property_id,
         coalesce(e.year, extract(year from coalesce(e.txn_date, e.created_at))::int),
         'cam',
         coalesce(nullif(btrim(e.party), ''), nullif(btrim(e.label), ''), 'Owner distribution'),
         abs(e.amount),
         false,
         e.txn_date,
         e.import_id
    from public.entity_ledger e
   where e.kind in ('draw', 'cost')
     and e.property_id is not null
     and not exists (
       select 1 from public.cam_line_items c
        where c.property_id = e.property_id
          -- `kind` is part of the key: without it a tax or roof line that happened to
          -- share the property, amount, label and date would read as "already migrated"
          -- and silently suppress the copy.
          and c.kind = 'cam'
          and c.billable = false
          and c.amount = abs(e.amount)
          and lower(btrim(c.label)) = lower(btrim(coalesce(nullif(btrim(e.party), ''), nullif(btrim(e.label), ''), 'Owner distribution')))
          and c.paid_date is not distinct from e.txn_date
     );
  get diagnostics v_moved = row_count;

  -- ── 3. What could NOT be moved, said out loud ─────────────────────────────────────
  --
  -- `entity_ledger.property_id` is nullable (a corporation-level cost belongs to no one
  -- building) and `cam_line_items.property_id` is NOT NULL. Such a row has nowhere to
  -- go and is LEFT WHERE IT IS rather than assigned to an arbitrary property — a figure
  -- filed against the wrong building is worse than one that stays put and is reported.
  -- In practice both writers ran from a property page, so this is normally zero.
  select count(*) into v_skipped
    from public.entity_ledger
   where kind in ('draw', 'cost') and property_id is null;

  -- Contributions are not copied anywhere: there is no amount-bearing home for money the
  -- owner puts IN. Adding one to other_income would have inflated the revenue figure the
  -- Income-and-expenses workbook prints by exactly what the landlord funded himself
  -- (src/lib/otherIncome.js states the refusal). The rows stay in entity_ledger, so
  -- nothing is lost — but nothing on screen counts them either, and that is deliberate.
  select count(*) into v_contrib from public.entity_ledger where kind = 'contribution';

  raise notice '0100: % expense line(s) written, % bucket record(s) created.', v_moved, v_buckets;
  if v_skipped > 0 then
    raise notice '0100: % entity row(s) had NO property and were left in entity_ledger — review them by hand.', v_skipped;
  end if;
  if v_contrib > 0 then
    raise notice '0100: % owner contribution(s) left in entity_ledger and counted nowhere (by design).', v_contrib;
  end if;
end $$;

comment on table public.entity_ledger is
  'RETIRED 2026-08-12 (0100). Owner draws and entity costs were copied into cam_line_items '
  'as not-billed lines carrying a bucket category; contributions were not copied and count '
  'nowhere. Nothing in the app reads this table any more. Kept, with its rows and its RLS '
  'intact, as the rollback for that move — dropping it is a separate, deliberate decision.';

comment on table public.fixed_assets is
  'RETIRED 2026-08-12. Capitalizing and the depreciation schedule were removed. ⚠ DO NOT '
  'DELETE ROWS: cam_line_items.asset_id references this table ON DELETE CASCADE (0080), so '
  'removing an asset would delete a REAL, BILLED expense line and change what tenants owe. '
  'The derived lines it created are now ordinary editable lines; this table is inert.';

comment on column public.expense_buckets.capital_prone is
  'UNREAD since 2026-08-12: it existed to decide when to offer "capitalize as an asset", '
  'and capitalizing was removed. Kept because dropping a column is destructive and the '
  'flag costs nothing to carry.';
