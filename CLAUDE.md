# Amlak — project notes for Claude

Commercial-property dashboard (React / Vite + Supabase), deployed on Cloudflare.

## Working alongside other sessions

> **Standing instruction (George, 2026-06-30):** George often runs several Claude
> sessions at once, each on its own task. Sessions can't see each other directly — the
> only thing they share is this project's files and git working tree. Follow these rules
> so sessions don't trip over each other:

- **Stay on your own task.** Only touch the files your task needs. Don't refactor,
  reformat, "clean up," revert, or rename anything outside it.
- **Treat unfamiliar in-progress changes as another session's work.** If `git status`
  shows modified files that aren't part of your task, assume another session owns them
  and leave them exactly as they are.
- **Commit/deploy only your task's files.** Stage only the files you changed for your
  task. Never bundle another session's unfinished changes into a commit or push them live.
- **Only flag a real overlap.** Tell George *only* when your task must change the same
  file or feature another session is clearly working on — then pause and ask before
  proceeding. If the tasks are separate, don't mention the other session; just do your job.

> **Standing instruction (George, 2026-06-30):** George runs several sessions at
> once and can't tell the VS Code windows apart at a glance. **Begin every reply
> with a one-line status line** — at the very top, before anything else — so he
> can scan which window is doing what:
>
>     📌 [<task>] <what this session is doing right now>
>
> - **`[<task>]`** — a short, stable name for this session's overall task
>   (e.g. `[Insurance emails]`). Keep it identical all session so it lines up with
>   this window's VS Code session/tab title.
> - **`<current step>`** — a few plain words on what's happening *right now*; this
>   part changes each reply (e.g. `wiring up the dedupe`, `deploying to
>   Cloudflare`, `done — pushed`).
> - One line, plain language. It's a label for George, not part of the answer.

## Acting on a confirmed change

> **Standing instruction (George, 2026-06-30):** When George confirms a change — by
> approving a plan in plan mode, or with any plain "yes, do it" — that confirmation **is**
> the go-ahead to take it all the way live. Don't finish the code and then stop to ask
> "should I deploy this now?" Carry it through to wherever it belongs: build + deploy to
> Cloudflare, push edge functions / run migrations on Supabase, and commit + push to GitHub
> so everything matches. One confirmation covers the whole round-trip — re-asking just to
> deploy wastes George's time.
>
> **Still ask first — these need George's explicit OK before you act:**
> - **Spending money** — buying a domain or service, paid signups, billing changes, or
>   anything that incurs a real charge. (Warn about the cost, then wait.)
> - **Emailing real tenants/customers** — any email to external recipients (not George).
>   Owner-only stays the rule until a sending domain is verified.
> - **Destructive / irreversible data** — dropping tables, deleting records, or migrations
>   that lose data.
> - **Going public** — opening signup past the 2-account private-beta cap, or anything that
>   exposes the app publicly.
>
> Outside those four, treat "confirmed" as "ship it."

## Following a change through

> **Standing instruction (George, 2026-07-27):** *"A lot of times, changing one thing in this
> software will have a lot of downstream effects on other places — like updating rent updates
> a lot of other things on the financials page, and vice versa. If you're changing something
> that has other implications, follow that line of logic and line of reasoning to make sure
> that nothing breaks long term, that all of those functions are coherent with each other and
> build off of one another, and nothing is left behind."*

**The rule.** Trace it **both ways before** the first edit — what feeds this value, and what
reads it — then walk the same chain **forward after**, confirming each link still agrees. If
you can't finish a link, say so explicitly in your reply *and* in the deploy-log entry. An
unfinished chain nobody names is exactly how a figure goes quietly stale.

This is not a general reminder to be careful. In this codebase a figure is entered once and
read by a dozen surfaces through shared pure functions, three SQL views, a hand-written demo
mirror and ~20 React Query key families — and **none of that is visible from the file you
happen to be editing**. The map below is what to check; every entry is code-verified.

### 1. The money spine

```
leases (base_rent · est_*_annual · square_footage · share_override_pct ·
        roof_responsible · lease_start · lease_termination_date)
expense_records + cam_line_items (kind = cam | tax | roof) · properties.building_sf
        │
        ├─→ v_tenant_shares / v_property_totals   (the split — SQL)
        │        │
        │        ├─→ buildLeaseSchedule → componentizeSchedule → the Ledger grid
        │        ├─→ billedComponents → the Financials per-tenant breakdown
        │        └─→ draft-invoice (edge) → a NEW invoice
        │
        └─→ invoices  ← A FROZEN COPY. It does not rebuild itself.
                 └─→ v_invoice_balances → Outstanding / receivables / the alerts'
                     owedByMonthForInvoice path
```

**The asymmetry is the whole point.** The breakdown and the Ledger build **up** from live data
(deliberate — 2026-07-21), so they follow any edit on their own. The stored invoice does not.
So anything that moves a billed figure must call the carry-through:

- one lease → `resyncLeaseBilling(leaseId, propertyId, year)`
- a property-wide figure (building size, a CAM / tax / roof total) → `resyncPropertyBilling(propertyId, year)`
- then `settleBillingChange(qc, { propertyId, leaseId, year })` (`src/lib/invalidate.js`) so the
  screens repaint

**`billable = false` IS THE OTHER HALF OF THIS SPINE, and it is now load-bearing in a way it
was not before.** `syncCamTotal` (`api.js`) sums only `billable is not false` into `cam_total`,
so a not-billed line reaches no view, no share and no invoice. That was a convenience for
tracking absorbed costs until 2026-08-12, when `entity_ledger` was retired (`0100`) and **owner
distributions became not-billed `cam_line_items` rows** — money that is not the building's,
sitting on the table the building bills from, kept inert by that one predicate. Anything that
changes how `cam_total` is summed now decides whether a landlord's draw appears on a tenant's
invoice. A distribution is marked by its bucket's `distribution` category (`isOwnerCategory`,
`expenseCategories.js`), which is also what keeps it out of every expense subtotal —
`recoverabilityRows` returns it in `owner`, never in `rows` or `totals`.

Both skip a **closed** year (one with a `financial_snapshots` row) — a bill already sent must not
move under the landlord because they edited something else. **Six** explicit estimate saves call
`resyncYearBillingToEstimate` directly and deliberately do not skip: `TenantShareTable.js` (the
save and its undo), `LeaseDetailPage.js`, `applyAddendum`, and `applyStatementImport` + its undo.
The first four fit the rule — the landlord typed a billed figure on that year's screen and meant
it. **The two statement-import ones do not** (the figure is inferred from a bank deposit) and are
worth revisiting.

**THE SERVICE CONTRACT IS THE SECOND SOURCE OF CAM**, and it feeds the same spine from the
other end (0091, George 2026-08-05: *"we need to add the same system to the contracts tab"*):

```
service_contracts (amount · frequency · escalation_pct · start/end) + contract_escalations
        │
        └─→ contractAnnualCost → syncContractCamItems → cam_line_items (contract_id)
                 └─→ syncCamTotal → expense_records.cam_total
                          └─→ v_tenant_shares.cam_amount   ← THE ACTUAL, never an estimate
                                   ├─→ Financials + Ledger  (build up — follow on their own)
                                   └─→ invoices  ← FROZEN. resyncPropertyBilling carries it.
```

- **The order is FORCED**: `syncContractCamItems(propertyId, year)` **first** (it moves
  `cam_total`), then `resyncPropertyBilling` — which reads `v_tenant_shares` ← `cam_total`.
  Resync first and every invoice rebuilds from the *old* CAM. One place does both:
  `carryContractChange` (`api.js`), called by `applyNewContractTerms`,
  `createServiceContractFromDocument`, `deleteServiceContract` and the inline Save-terms path.
- **A CONTRACT NOW HAS A SECOND WAY IN — e-signature (0093).** `signature_envelopes.lease_id`
  is nullable and `contract_id` is its alternative (`ck_env_one_owner`: exactly one). Sending
  and countersigning book **nothing** (0085's rule, unchanged); the money moves only when
  `SignedContractModal` → `readSignedContractEnvelope` (reads `executed_path`, writes
  `contract_text`, moves no figure) → `applyNewContractTerms({ envelopeId })`, which runs the
  identical carry-through above and stamps `applied_at`. **`applied_at` is the only thing
  that clears the "Read the signed contract" prompt and the `signature_apply` alert**, so any
  new path that files a signed contract must stamp it — `markEnvelopeApplied` exists for the
  "read it, nothing changes" case for exactly that reason.
- **NOTHING on the contract path may write an estimate** — no `est_*` column, no
  `lease_estimates` row. That is not a restraint, it is the mechanism behind George's
  *"this only affects the ACTUAL CAM and Tax not estimated"*: `billedComponents` prefers a
  tenant's estimate and falls back to `share.cam_amount`, so writing nothing means a tenant on
  an estimate keeps paying it and settles at ⚖ Reconcile while a tenant without one re-prices
  now. Pinned by `contractCarryThrough.test.js`.
- **`contract_escalations` is DERIVED, never applied** — no `status` column and no sweep,
  because nothing writes `service_contracts.amount`. The step in effect for a fiscal year is
  the **last** step whose `effective_date` falls in that year **or earlier** (year-of, so a
  November step prices the whole of its own year). An empty table reproduces the pre-0091
  scalar path byte for byte, which is why there is no back-fill.
- ⚠ `syncContractCamItems` → `syncCamTotal` has **no closed-year guard** — it will move
  `expense_records.cam_total` for a closed year (only the invoice is protected). Pre-existing;
  `CamSection` triggers it on every year open.

**A change to a billed figure has a DATE**, and the months before it belong to the old lease
(George, 2026-08-04). Rent carries this in `rent_escalations` → `monthlyBases`; the CAM & tax
estimate carries it in **`lease_estimates` (0089) → `monthlyEstimates`** (`reconciliation.js`).
Both need a **closing** row (the old figure, at the start of its era) as well as a boundary row —
one alone still leaves January reading the live scalar. An empty `lease_estimates` reproduces
pre-0089 behaviour exactly, which is why there is no back-fill.

**The closing row must be written even when there IS no old figure** (`cam_tax_none`, `0090`).
A lease going from **no** estimate to one is the commonest shape of the change, and its earlier
months were billed at the tenant's *actual* share — so "no closing row" meant re-pricing them at
the new estimate, the exact fault 0089 exists to prevent. Null `cam_tax_annual` could not express
it: null already means "this row says nothing about CAM & tax". The flag is scoped to CAM & tax
because `est_roof_annual` is deliberately **not** among the fields a new lease applies
(`newLeaseTerms.js` `FIELDS`) — add roof there and you must give roof the same flag.

**And the closing row is not only about the rent.** Its second job is pulling `occupancyStart`
back to the real move-in, which is needed whenever `lease_start` moves **forward** — whatever the
rent did. Gate it on a rent change and a renewal at the same rent commencing later takes every
earlier month out of term. Dedupe it against **applied** rows only; a scheduled row says nothing
about occupancy.

**The invoice can still fall behind**, because the rent-step sweep also runs nightly in SQL
(`apply_due_escalations()`) where no JS carry-through can fire. `invoiceDrift` (`api.js`) measures
schedule-vs-invoice and the Ledger row offers **Rebuild** — the backstop for every writer,
including ones nobody has thought of.

### 2. The four choke points

Change one of these and you have changed every money screen at once. Read all the callers first.

| Function | Lives in | Read by |
|---|---|---|
| `buildLeaseSchedule` | `src/lib/leaseSchedule.js` | `ledger.js`, `api.js` (5 call sites) — and note its **two documented modes**: projection (no `invoiceTotal`) vs reconcile-to-bill (scales + penny-folds to settle an issued invoice exactly) |
| `allocatePayments` / `componentizeSchedule` | `src/lib/ledger.js` | the Ledger grid, the reminders, `closeYear`, `reconciliationData.js`, and since 2026-08-12 `incomeExpense.js`. `componentizeSchedule` holds the invariant **base + camTax + roof === owed** per month — which is why the Income-and-expenses rent row reads `base` for a NET lease and `base + camTax + roof` for a **gross** one (`0073`: a gross tenant's share is carved OUT of a flat rent that `total_revenue` counts whole). Get that branch wrong and the sheet either double-counts the reimbursement or under-reports the rent. It also **derives** the sheet's rent where the view used to supply it, so `shapeProperty` carries `rentDrift` and `flags()` prints any gap over $1 — a JS↔SQL twin with a visible tie-out rather than a silent one |
| `billedComponents` | `src/lib/reconciliation.js` | `TenantShareTable`, `LeasesPage`, `ledger.js`, `reconciliationData.js`, `api.js` |
| `contractAnnualCost` | `src/lib/contracts.js` | `syncContractCamItems` (`api.js` — → `cam_line_items` → `cam_total` → shares → a stored invoice), `ContractItem` (`ServiceContractsSection.js`), `ContractReview` (`ContractDocs.js`). Signature is `(contract, year, steps)`; **every caller must pass the 0091 steps**, in ONE bulk read, or two screens quote different annual costs for one contract. (It had a fourth caller, `vendorRowsFor` in `form1099.js` — removed 2026-08-12 with the 1099 worksheet.) |

### 3. Mirrors that must move together

Two implementations of one rule always drift unless changed in the same commit.

- **The owner-capital rule is ONE predicate on purpose:** `isOwnerCategory`
  (`expenseCategories.js`) decides that a `distribution` line is not a cost, and both the
  on-screen "What it cost you" table and the Income-and-expenses workbook read it through
  `recoverabilityRows`' `owner` / `ownerTotal`. Neither re-derives it. A second copy would
  let the screen and the sheet disagree about whether a landlord's draw is an expense —
  and only one of them would be wrong in front of an accountant.
- **THE MONTHLY GRID GROWS ON THE EXISTING GROUPERS, never beside them** (2026-08-12).
  `recoverabilityRows` rows carry `byMonth` / `undated` / `items` and `summarizeOtherIncome`
  groups carry `byMonth` / `undated`, because which category or bucket a dollar files under
  is decided once. The Income-and-expenses workbook reads those; it groups nothing itself.
  **`undated` is a REAL figure, not a remainder** — `cam_line_items.paid_date` is nullable and
  never backfilled (`0074`), a contract-derived CAM line never carries one, and a kind entered
  as a flat total has no day at all (on the demo seed that is $31,000 of $49,950). Every grid
  therefore prints a **No date** column and `flags()` states the sum; `monthOfYearIndex`
  (`isoDate.js`) is the one place that decides a row has no usable month, and it answers null
  for a date outside the row's stored `year` too.
- **`net === noi + recovered + otherIncome − absorbed`, and the last term is the one that gets
  dropped.** NOI is `total_revenue − total_expenses` and `total_expenses` comes from `cam_total`,
  which sums `billable is not false` only — so a cost the landlord entered and chose to eat is in
  the workbook's `spent` and in none of NOI. The sheet shipped on 2026-08-12 printing this
  reconciliation without it, wrong by exactly that figure, for an accountant to find. Pinned in
  `incomeExpense.test.js`.
- **A SECTION THAT FOLDS USES `Panel` (`src/components/Panel.js`) — never a hand-rolled
  `.panel-toggle`.** The pattern had been copied four times before 2026-08-12 and the four had
  already drifted into two default states and two hit-target sizes; a dozen more copies would
  have made that permanent. `Panel` also enforces the rule this codebase keeps: **a folded panel
  still states what it holds** (`summary`), because a fold that hides its own figure just gets
  reopened. Its state is remembered per section in one `localStorage` key via
  `usePanelOpen` (`src/lib/panelState.js`), which stores **only sections the user has actually
  toggled** — a key written on first render would freeze today's defaults into their browser.
  ⚠ Any panel a **`?focus=` alert can point at** must be *controlled* by its page and forced open
  before the scroll-and-flash (`openByFocus`, `LeaseDetailPage.js`) — a remembered fold is exactly
  the state an alert has to overcome. Two copies survive on `HistoryPage.js` and should move here.
- **JS ↔ SQL twins:** `effective_rent` (migration `0054`) ↔ `effectiveRent` (`escalations.js:38`) ·
  `abatement_credit` (`0041`) ↔ `abatement.js` · `app_today()` (`0051`) ↔ `localDateIso` (`api.js:36`) ·
  the renewal-option lapse rule in `apply_due_renewals()` (`0068`) ↔ `optionLapseReason`
  (`renewals.js`).
- **The estimate-preferred billing math is now TWO copies, not four:** `billedComponents`
  (`reconciliation.js`) ↔ `draft-invoice/index.ts`. `api.js` and `mockClient.js` both delegate to
  `billedComponents` and are no longer separate implementations. The **dated** estimate is the
  same pair: `monthlyEstimates` (`reconciliation.js`) ↔ the `estSeries` block in
  `draft-invoice/index.ts` — change one and a freshly drafted invoice disagrees with the resync
  that maintains it.
- **`payments.source`** (`0088`) is the only thing separating a real cheque from a figure the app
  priced itself. It is stored, never inferred: a null note is NOT a proxy for "the app made this
  up", because neither way of recording a real payment writes one. Only `'system'` rows may be
  re-stamped by `resyncYearBillingToEstimate`. **Every writer must STATE it — never leave it to
  the column default.** The mock applies no defaults, so a row written without it is `'system'`
  live and `undefined` in demo, and the guard reads undefined as *not* system: the two behave
  oppositely and the tests only ever see the demo side (`markMonthsPaidAllTenants`, 2026-08-05).
- **The CONTRACT extractor's mirrors (0091):** `CONTRACT_FLAG_DEFS` (`_shared/contractFlags.js`)
  is a second *vocabulary*, not a second engine — `leaseFlags.js`'s parser takes an optional
  `defs` argument (`flagsFromVerdicts`, `normalizeReviewFlags`, `buildReviewRecord`,
  `flagInstructionFor`, `flagLineSpecFor`), defaulting to `LEASE_FLAG_DEFS` so nothing on the
  lease path moved. `contractMismatches` (`_shared/analystVerdicts.js`) ↔ its labels in
  `src/lib/analystBrief.js` — that pair genuinely IS a twin and must move together.
  **`noticeDueDate` (`src/lib/contractTerms.js`) is deliberately ONE implementation** with two
  callers — the review dialog and `updateServiceContract` — because a second copy would let
  the reminder fire on one date while the screen printed another.
- **The extract-contract SCHEMA is at 15 of Anthropic's 16 union-typed parameters (0094).**
  One slot left. The 17th 400s **every** contract extraction, silently, until someone reads
  the logs — so whoever needs the next scalar splits it into two calls the way `extract-lease`
  already does, rather than spending the last one. The count is stated above `SCHEMA`; keep it
  accurate.
- **`counterparty(env)` (`src/lib/envelopes.js`) is the ONLY place that decides "tenant" vs
  "vendor"**, derived from `env.contract_id` rather than passed in. `envelope_signers.role` is
  still `'tenant'` on a contract envelope — 0085's CHECK allows exactly (`tenant`,`landlord`)
  and widening it would touch `sign-envelope`, the one unauthenticated endpoint in the project.
  The role names the SIDE that holds the link, not the kind of person. Any new surface that
  prints who is on the other end must call this, never re-derive it.
- **`isoDateOrNull` lives in `src/lib/isoDate.js`** — dependency-free on purpose, so pure libs can
  guard a date without an import cycle into `api.js` (which re-exports it). Its twin is
  `realIsoDate` in `_shared/rentSchedule.js`; that copy is unavoidable (the app build can't import
  into `supabase/`), a third is not. It rejects dates that *parse but don't exist* — V8 rolls
  `2033-04-31` to May 1, and Postgres does not.
- **`xlsx.js` is the shared workbook writer** (`XLSX_PALETTE` / `xlsxSheet` / `xlsxPen`).
  It lived inside `cpaExcel.js` until 2026-08-12, which made the tax package load-bearing
  for two exports that had nothing to do with a tax return; it moved out when all three
  were removed. ⚠ `xlsxSheet` must never emit `{ state: 'frozen', ySplit: 0 }` — a pane
  that splits nothing makes Excel call the file damaged. `workbookValidity.test.js` unzips
  the real bytes and asserts this structurally, because a corrupt `.xlsx` is still a
  well-formed zip of the right size and every `blob.size > 4000` check passes over it.
  `reconciliationExcel.js` and `rentRollExcel.js` still roll their own writers.
- **The demo mock hand-implements the views.** `mockClient.js` reimplements `v_property_totals`
  (:37), `v_tenant_shares` (:73), `v_invoice_balances` (:111), `draft-invoice` (:369) and
  `create_lease_tx` (:774). **A view change without a matching mock change means the suite passes
  over behaviour that is broken live** — which is precisely the `not()` incident (see the comment
  at `mockClient.js:155`). Update both, same commit.

### 4. Registries where every entry has to be filled

- **A new alert type** touches: the `buildAlerts` block · its feature gate · the **`alertKey`
  anchor chain** (`alerts.js:23` — a new entity id must be added there or the key collapses to
  `undefined` and dismissals collide) · a `NOTIFY_TYPES` entry (`notifyPrefs.js`) if it has a lead ·
  `alertCanEmail` + `goToAlert` (`DashboardPage.js:100,119`) · the `fetchAlertData` payload ·
  and, if it emails, a `send-reminders` sweep plus a `*_notice_bucket` column to dedupe on
  (`0057`/`0059`).
- **The three CONTRACT alert focuses** — `contract` (expiry), `contract_notice` (the
  cancellation deadline, and the only one of the three that costs money if missed) and
  `contract_escalation` (a fee step coming due, dashboard-only) — all live inside one
  `contractsOn` gate in `alerts.js` and share one `ctx` so `alertKey`'s `contract_id` anchor
  gives three distinct dismissal keys. `contract_notice` fires whenever `notice_by_date` is
  set, **regardless of `auto_renew`**: the flag drives the wording, not the alert's existence.
  Leads default to **60** days, not 183 — a six-month countdown to a 30-day window is noise.
  No `features.js` change and **no backfill**: `contracts` is already in every production
  `enabled_features` array (`0084`), which only holds because this extends an existing module.
- **The two SIGNATURE focuses now have two kinds of home (0093).** `signature_countersign` and
  `signature_apply` are raised for a lease envelope *and* a contract envelope from one block,
  and every branch differs: the word for the other side (`counterparty`), the anchor
  (`contract_id` instead of `lease_id`, both carried so `alertKey` never sees `undefined`),
  the destination (`goToAlert` routes anything with a `contract_id` and no `lease_id` to the
  Contracts tab), and the wording — an unread signed CONTRACT means the tenants are still
  being billed the old fee, which is a money statement, not untidiness. **Both gates must
  pass**: `esignOn && contractsOn`, because turning Service contracts off hides the tab the
  alert points at. No new `NOTIFY_COLUMNS` / `NOTIFY_TYPES` entries — same two focuses.
- **A new optional module** touches `FEATURES` (`features.js:11`) plus every gate that reads it —
  tabs, route redirects, page sections, `buildAlerts`, `fetchAlertData`, the email sweep, the Ask
  facts, and the demo mock. `grep -rl "isOn('insurance')"` is the fastest way to see the full set.
  **…and it MUST ship a backfill migration, or it is invisible in production.** `isFeatureOn`
  reads a stored `null` as "everything on" but a stored **array** as "exactly this set", and every
  account that has ever touched the Settings toggles holds an array. A key merely appended to
  `FEATURES` is absent from that array, which reads as OFF. **The demo will not catch this** — it
  seeds no `user_preferences` row, so it runs the `null` path and shows the module happily while
  production hides it (that is exactly how `announcements` shipped invisible, 2026-08-04). Copy
  `0084_backfill_announcements_feature.sql` and change the key.
- **A STATEMENT LINE'S DECISION IS WRITE-ONLY UNTIL SOMETHING READS IT BACK** (2026-08-13).
  `statement_lines.disposition` + `ignore_reason` have been stored since 0076, and for two weeks
  **nothing rendered them** — `listStatementLines` had zero importers and `ignoreReasonLabel` zero
  callers, so a line the landlord filed left the screen forever. The read path is now
  `listDecidedLines` (`api.js`) → the **Decided** panel on the Ledger, the mirror of
  `listUnplacedLines` with identical FY scoping so a line sits in exactly one of the two.
  ⚠ **Undo is offered for `ignored` and `transfer` ONLY.** Those write no money — the disposition IS
  the record — so un-deciding them is lossless. Every other disposition wrote a real `other_income` /
  not-billed `cam_line_items` / deposit row, and `setLineDisposition` deliberately does not touch
  money: offering Undo there orphans that row and lets the line be placed a second time. Any new
  disposition must declare which side it is on.
- **A TAGGED PAYMENT'S EXCESS GOES NOWHERE — not to a later month, not into `credit`.**
  `allocatePayments` settles a tagged month at whatever arrived, with no cap and no rollover; only an
  *untagged* lump pools forward, and the import auto-tags nearly every deposit from its own date, so
  the invisible case is the common one. `updatePayment(id, {period_month})` is the one way to move it:
  a month re-files the cheque, `null` untags it into the pool. ⚠ It writes `period_month` **only** —
  restating `source` would re-stamp a real cheque as `'system'` and make it re-pricable by
  `resyncYearBillingToEstimate` (0088). And the pool fills each month's remaining need **from
  January**, not from the payment's own month; any copy that says otherwise is wrong.
- **`monthsBehind` WAITS FOR THE MONTH TO END; `owesToDate` DOES NOT** (George, 2026-08-13). Rent
  falls due on the 1st, so an unpaid running month is genuinely owed — that is what keeps `owesToDate`
  tying to `arStatus.amountBehind` to the cent. What waits is the **accusation**: the bank statement
  that would settle the month does not exist yet. Both the badge and the grid's gold `late` cell call
  `monthClosedForLogging(year, m, today, 0)` — the same function the two statement reminders use, with
  no grace. Keep the split; collapsing it breaks a balance or restores a false accusation.
- **A WRITE-IN CATEGORY IS `custom:<slug>` AND THE MACHINERY IS SHARED, NEVER COPIED.**
  `otherIncome.js` imports `CUSTOM_PREFIX` / `isCustomCategory` / `customCategoryKey` from
  `expenseCategories.js` (which imports nothing, so it cannot cycle). Validity is **structural**,
  which is why a key survives call sites that have never heard of the landlord's list; the offered
  list is derived from use (`incomeCategoriesInUse`), so there is no table and nothing to keep in
  sync. ⚠ Every income category is money the **property earned** — one export prints the lot as
  revenue — so a write-in must never become the back door for owner money that the refusal of a
  `contribution` category exists to keep shut.
- **THE LEDGER RAISES THREE ALERTS, NOT TWO** (2026-08-13). `statement_reminder` and
  `missing_payment` were joined by **`escalation_short`** — a rent step landed and the money since
  is still the pre-raise amount. All three are precomputed in **`computeLedgerAlerts`** (`api.js`)
  from the same `allocatePayments` the Ledger grid paints from, all three sit inside one
  `ledgerOn` gate, and all three route to the **Ledger**, not the lease page. ⚠ The new one
  **derives no rent step of its own**: it works from `owedByMonthForInvoice` (scaled to the STORED
  invoice) while the Ledger works from the live projection, so it takes the step *month* from the
  applied `rent_escalations` row and every *figure* from `escalationFollowThrough` reading that
  same owed array. A second step-detection here is the §3 drift that makes two screens quote
  different dollars for one raise. It also buys the stale-bill case free — no jump in the invoice,
  no alert, and the Ledger's existing `bill behind by $X · Rebuild` says the true thing instead.
  Only the **`pre_raise_rate`** verdict is raised; `partial` and `older_gap` are real gaps but
  read as accusations without the months around them, so they stay on the row.
- **A new `history_events` type** touches three registries or it renders as a bare slug in one of
  them: `EVENT_LABEL` and `EVENT_BADGE` (`HistoryPage.js`) plus **either** `STORY_EVENTS` or
  `LEDGER_EVENTS` (`tenantStory.js`) — an unknown type falls to the ledger log rather than
  vanishing, so a missing entry is quiet rather than loud.
- **A new Ask Amlak fact** must bump the `snapshotFingerprint` version prefix (`portfolio.js:61`,
  now `v6`) — otherwise every previously cached answer keeps serving the thinner summary.

### 5. Deploy fan-out — a shared edge module makes its importers stale

Measured 2026-08-12 (`grep -rl "_shared/<file>" supabase/functions --include=index.ts | wc -l`
— re-measure rather than trust these; the previous numbers here were three rounds stale):
`_shared/cors.ts` and `_shared/ratelimit.ts` → **25** functions · `_shared/anthropic.ts` → **17** ·
`_shared/pdf.ts` and `_shared/docx.ts` → **4** each · `_shared/analystVerdicts.js` and
`_shared/leaseFlags.js` → **3** each · `_shared/rentSchedule.js` and `_shared/transcribe.ts` →
**2** each · `_shared/contractFlags.js` → **1**. Redeploy every importer in the same round, or the
deployed copy silently drifts from source.

### 6. Query-key invalidation

Named sets exist, and they are deliberately different: **`settleBillingChange`**
(`src/lib/invalidate.js`) for "a billed figure moved", **`settleLeaseScheduleChange`** /
**`settleLeaseListChange`** for a lease's own page and the three lists that render it,
**`settleContractChange`** (0091 — the contract, its fee steps, the derived CAM row,
the history log, and since 0093 `['envelopes']` — the prefix covers both `['envelopes', leaseId]`
and `['envelopes', contractId]`, and without it applying a signed contract stamps `applied_at`
while the prompt and the alert keep asking; called **alongside** `settleBillingChange`, never
instead), and
**`settleStatementImport`** (`ImportStatementButton.js:98`) for the wider statement-specific set
(register, learned payees, history). Add a NAMED one rather than hand-rolling a list at the call
site — hand-rolled lists drift apart by omission, which is how the invoice drift above survived
unnoticed, and how editing a contract's end date left the dashboard bell showing the old expiry.

## Following the change through the user's hands

> **Standing instruction (George, 2026-08-05):** *"See how I walked you through the entire
> process? The upload, the click, during, after, explaining, UI, how does the user know? These are
> all questions that should be reviewed by you before you present a plan, so we don't have to do
> this for every single addition to the software now that we're getting more complex."*

**The rule.** *Following a change through* above traces the **figure**. This traces the **person**.
Walk the whole journey before presenting a plan and answer these **in the plan** — not after George
asks. A feature that computes the right answer and leaves the landlord unable to find it is not
finished.

1. **Getting in.** How does the thing arrive — upload, drag, paste, import, a typed field? What
   happens on the wrong file, an empty one, or one already there?
2. **Before the click.** Does the button say what it is about to do, what it costs, and what it will
   **not** touch? Anything paid, slow or destructive asks first (`useConfirm`, `ConfirmDialog.js`),
   and `tone` matters — red is for permanent deletes, not for a paid read.
3. **The price, if there is one.** Quote a figure the screen can actually derive. A number computed
   from a column the page's query doesn't select is wrong on every live click **and right in the
   demo**, because `mockClient`'s builder ignores column lists (§3).
4. **During.** What is on screen while it runs — which item, how many left, is the button disabled,
   can the user navigate away?
5. **After: what happened.** Not a count. **Which** records changed, by how much, and where they
   went. "10 findings" tells the landlord nothing he can act on.
6. **After: where do I look.** The result must link to the records it describes. If the report is
   ephemeral (a message that dies on navigation), something durable must mark those records — a
   badge on the row, a state on the card — or the work is findable only by someone who already
   knows where it lives.
7. **Can the user see it at all?** Check every gate between the result and the eye: `features.js`
   modules, the Display-settings panels (`dashboardWidgets.js`), a tab hidden when a module is off.
   Paying for a result the app then refuses to render is the worst version of this, and the demo
   cannot catch it — it seeds no `user_preferences` row.
8. **What next.** Having seen it, what is the user supposed to *do*, and is that action on the same
   screen?
9. **When it goes wrong.** Is the failure legible — a sentence, not a slug or a status code? Does a
   **partial** result say it is partial? A half-read document reporting "the lease is silent on X"
   is a wrong answer stated confidently.
10. **The second time.** Does re-running cost again, overwrite, or skip? Does the screen distinguish
    "checked and clean" from "never looked at"?

Answer each in a line. Where the answer is "nothing happens" or "the user has to already know",
that is the gap — it belongs in the plan, not in George's next message.

## Saying what the change made redundant

> **Standing instruction (George, 2026-08-17):** *"see how I realized that? is there a way you can
> teach yourself to notice these kinds of things or a sentence or two you could write in the md that
> allows you to be proactive in changes not reactive? but of course with my permission on the final
> changes?"*

**The rule.** Adding a better way to say something does not remove the old way, and **nobody ever goes
back for it**. So every plan and every deploy-log entry ends with a **Now redundant** list: what this
change has just made unnecessary, duplicated or contradictory, one line each on why. **Propose it;
never delete on your own authority** — George picks from the list. That is the whole trade: he gets
the noticing without losing the say.

The two sections above trace what a change *breaks*. This one traces what it *replaces*, which is the
half that never announces itself — nothing errors, no test fails, the screen simply keeps carrying two
answers to one question until a landlord trips over the older one.

Where to look, in order. Every entry below has actually happened here:

1. **The thing the new thing replaced.** The Ledger's hover card retired a three-line printed note
   *and* the entire eight-swatch Key row — the second one sat there for a whole round because nobody
   asked. `Panel` retires a hand-rolled `.panel-toggle`. The one-click box toggle retired "Undo this
   month" in the pop-up.
2. **A second way to do one job.** Two doors to one action drift, and the older one keeps the older
   rules: the grid's un-tick asks before deleting money that came off a bank statement; the pop-up's
   version never did.
3. **Prose that exists because the screen could not say it.** A paragraph explaining a panel is a
   symptom, not a feature. If the panel now says it, cut the paragraph; if the paragraph is still
   needed, the panel is not finished.
4. **A registry entry, CSS rule or helper with no reader left.** `grep` the name before shipping — a
   dead `.rr-key-item` costs nothing and quietly asserts that the thing it styled still exists.

If a change makes nothing redundant, write **"Nothing redundant"**. The point is that the question was
asked out loud, not that something is always found.

## Deploying to production

- **Target:** Cloudflare Worker named `amlak` (serves the static `./build` directory).
- **Live URLs:** https://amlakre.com (primary, custom domain since 2026-07-11) +
  https://www.amlakre.com + https://amlak.akkawigeo-5.workers.dev (original, kept working).
- **Steps:** `npm run build` (= `vite build`, outputs `./build`) → `npx wrangler deploy`.
  - **Build tooling is now Vite** (migrated off Create React App 2026-07-06). Tests run
    via `npm test` (= `vitest run`). The old `react-scripts build`/`react-scripts test`
    commands no longer exist.
- There is **no GitHub CI** — deploys happen locally via wrangler. `main` is the
  deploy branch; after deploying, commit + push so GitHub matches what's live.

## Deployment log

> **Standing instruction (George, 2026-06-30):** Every time George confirms a change
> needs to be deployed live, append a dated entry recording what went out (what changed,
> the files, and the Cloudflare version id). Keep newest at the top.

**The log lives in [`docs/deploy-log.md`](docs/deploy-log.md), not here** (moved 2026-08-04).
It is ~8,000 lines and this file is injected in full into context at every session start and
after every `/clear` and `/compact` — keeping it here cost ~212,000 tokens per session before
any code was read.

- **Writing:** append the new entry at the TOP of `docs/deploy-log.md`, same format as the
  entries already there.
- **Reading:** it is the record of every decision, refusal and gotcha this codebase has hit —
  **grep it before changing anything with history** (`grep -n "reconcile" docs/deploy-log.md`),
  rather than reading it whole. §1-§6 above are the map; the log is the detail behind them.
