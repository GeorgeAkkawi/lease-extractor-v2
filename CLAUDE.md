# Amlak — project notes for Claude

Commercial-property dashboard (React / CRA + Supabase), deployed on Cloudflare.

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
| `allocatePayments` / `componentizeSchedule` | `src/lib/ledger.js` | the Ledger grid, the reminders, `closeYear`. `componentizeSchedule` holds the invariant **base + camTax + roof === owed** per month |
| `billedComponents` | `src/lib/reconciliation.js` | `TenantShareTable`, `LeasesPage`, `ledger.js`, `reconciliationData.js`, `api.js` |
| `contractAnnualCost` | `src/lib/contracts.js` | `syncContractCamItems` (`api.js` — → `cam_line_items` → `cam_total` → shares → a stored invoice), `vendorRowsFor` (`form1099.js` — **a tax form**), `ContractItem` (`ServiceContractsSection.js`), `ContractReview` (`ContractDocs.js`). Signature is `(contract, year, steps)`; **every caller must pass the 0091 steps**, in ONE bulk read, or the CAM the tenant is billed stops matching the 1099 the vendor is issued |

### 3. Mirrors that must move together

Two implementations of one rule always drift unless changed in the same commit.

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
- **`isoDateOrNull` lives in `src/lib/isoDate.js`** — dependency-free on purpose, so pure libs can
  guard a date without an import cycle into `api.js` (which re-exports it). Its twin is
  `realIsoDate` in `_shared/rentSchedule.js`; that copy is unavoidable (the app build can't import
  into `supabase/`), a third is not. It rejects dates that *parse but don't exist* — V8 rolls
  `2033-04-31` to May 1, and Postgres does not.
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
- **A new `history_events` type** touches three registries or it renders as a bare slug in one of
  them: `EVENT_LABEL` and `EVENT_BADGE` (`HistoryPage.js`) plus **either** `STORY_EVENTS` or
  `LEDGER_EVENTS` (`tenantStory.js`) — an unknown type falls to the ledger log rather than
  vanishing, so a missing entry is quiet rather than loud.
- **A new Ask Amlak fact** must bump the `snapshotFingerprint` version prefix (`portfolio.js:61`,
  now `v5`) — otherwise every previously cached answer keeps serving the thinner summary.

### 5. Deploy fan-out — a shared edge module makes its importers stale

Measured 2026-08-05 (`grep -rl "_shared/<file>" supabase/functions --include=index.ts | wc -l`
— re-measure rather than trust these; the previous numbers here were three rounds stale):
`_shared/cors.ts` and `_shared/ratelimit.ts` → **26** functions · `_shared/anthropic.ts` → **18** ·
`_shared/pdf.ts` and `_shared/docx.ts` → **4** each · `_shared/analystVerdicts.js` and
`_shared/leaseFlags.js` → **3** each · `_shared/rentSchedule.js` and `_shared/transcribe.ts` →
**2** each · `_shared/contractFlags.js` → **1**. Redeploy every importer in the same round, or the
deployed copy silently drifts from source.

### 6. Query-key invalidation

Named sets exist, and they are deliberately different: **`settleBillingChange`**
(`src/lib/invalidate.js`) for "a billed figure moved", **`settleLeaseScheduleChange`** /
**`settleLeaseListChange`** for a lease's own page and the three lists that render it,
**`settleContractChange`** (0091 — the contract, its fee steps, the derived CAM row, the 1099
and the history log; called **alongside** `settleBillingChange`, never instead), and
**`settleStatementImport`** (`ImportStatementButton.js:98`) for the wider statement-specific set
(register, learned payees, history). Add a NAMED one rather than hand-rolling a list at the call
site — hand-rolled lists drift apart by omission, which is how the invoice drift above survived
unnoticed, and how editing a contract's end date left the dashboard bell showing the old expiry.

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
