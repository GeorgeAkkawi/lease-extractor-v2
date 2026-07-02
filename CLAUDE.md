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

## Deploying to production

- **Target:** Cloudflare Worker named `amlak` (serves the static `./build` directory).
- **Live URL:** https://amlak.akkawigeo-5.workers.dev
- **Steps:** `CI=true npx react-scripts build` → `npx wrangler deploy`.
- There is **no GitHub CI** — deploys happen locally via wrangler. `main` is the
  deploy branch; after deploying, commit + push so GitHub matches what's live.

## Deployment log

> **Standing instruction (George, 2026-06-30):** Every time George confirms a change
> needs to be deployed live, append a dated entry below recording what went out
> (what changed, the files, and the Cloudflare version id). Keep newest at the top.

- **2026-07-02** — Lease-page overhaul: addendum rent math, escalation→base-rent, current-phase
  header, lapsed-option hiding, hide toggles, declutter. Deployed: `extract-addendum` edge function +
  DB migration `0039` (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `380885ee`.
  - **Addendum base-rent math was wrong (the core bug).** `extract-addendum` asked the *model* to
    multiply ($/mo×12, $/SF×sqft) — models read reliably but multiply unreliably. Ported the fix
    extract-lease already uses: a separate non-fatal **rent-supplement call** returns the RAW figure +
    basis and the shared `_shared/rentSchedule.js` `rebuildRentSchedule()` does the math in code, to the
    cent, overriding the model's own new_base_rent/escalations. The app now passes the lease's own
    `square_footage` so a $/SF row annualizes even when the rider doesn't restate the size; a bad-math /
    missing-sqft row raises the same "double-check these amounts" badge as lease import. Files:
    `extract-addendum/index.ts`, `_shared/rentSchedule.js` (now also returns `baseDate`), `api.js`
    (`extractAddendum` passes `squareFootage`), `AddendumEditor.js` (sends sqft + shows the badge),
    `LeaseDetailPage.js`.
  - **Applied escalations now always update the base rent up top.** `backfillLeaseToToday`'s *expired*
    branch marked past steps "applied" but never wrote `base_rent` — so a step like "Jun 1 2020 →
    $24,200" showed applied while the header stayed stale forever (applyDueEscalations skips applied
    rows). Fixed to also write the last-known rent. `EscalationScheduleEditor` now re-resolves the lease
    (backfill) + refreshes `['lease']` on add/delete so a past-dated step takes effect immediately.
  - **Lease terms header shows the CURRENT phase, not the lease from its original start.** New
    `currentPhase()` in `leaseTerm.js` → label / current rent-period window / rent in effect / next
    scheduled step. `currentTermLabel` now recognizes an applied EXTENSION addendum ("Extended term —
    First Amendment"). Wired into `LeaseDetailPage` header + holdover banner and `leaseContext.js` (so the
    AI assistant's stated phase matches).
  - **Past-due renewal options no longer listed.** A *pending* option lapses once its term slot has
    ended: hidden from `RenewalOptionsEditor` (with a small "N lapsed not shown" line),
    `isRenewalDecisionDue` returns false past term end, `promptDueRenewalDecisions` clears any stale
    prompt, and migration `0039` gives the SQL cron `apply_due_renewals()` the same cutoff (non-destructive
    `create or replace`).
  - **Monthly rent / Receivables / property rent roll are now hideable** (George: "give the option to
    hide it"). Reused the per-account Display-settings store (`user_preferences.hidden_widgets`, no
    migration) — new `PAGE_PANELS` group in `dashboardWidgets.js`, a second section in `DisplaySettings.js`,
    gates in `LeaseDetailPage.js` (panels + the fiscal-year selector) and `PropertyFinancialsPage.js`.
    Default shown; nothing deleted from the DB.
  - **Decluttered** the long explainer paragraphs on the lease page (renewal, addendum, assistant,
    insurance, monthly-rent) and the 5-bullet renewal help list → 2 bullets.
  - Verified token-free: new `src/lib/__tests__/leasePhaseAndBackfill.test.js` replays the $24,200
    expired-term symptom (base rent now updates), `currentPhase` label/date/rent/next-step, the addendum
    $/SF math, and lapsed-prompt clearing. Full suite 28/28 green; `CI=true` build compiles. Committed only
    this task's files.

- **2026-07-01** — Renewal emails, follow-up: a lease-page **"✉ Email tenant"** button. Frontend
  Cloudflare version `f7920f34`. No migrations, no edge functions.
  - **Why:** the "renewal approaching" heads-up only appeared in the dashboard bell, and only inside the
    ~3-month due window — George couldn't find a way to send it proactively. Now every **pending**
    renewal option on the lease page has a "✉ Email tenant" button that opens the same send modal with a
    ready-to-send "your renewal is coming up" draft, sendable **any time**.
  - `src/lib/api.js` — new `draftRenewalApproachingEmail(renewalId)` builds the letter (reuses
    `buildRenewalApproachingEmail` + property/corp business) and returns the modal's email fields; no
    notification is created. `src/components/RenewalOptionsEditor.js` — the button + `NotificationEmailModal`
    (onSent just closes; nothing to dismiss) + a help-text line. New test case in `renewalEmails.test.js`
    (5/5 green).
  - **Deploy note (regression I caught + fixed):** while I was building, the widgets deploy (`8a06310e`)
    had advanced the live frontend past my earlier renewal base. My first button build from the stale
    `cc6f9e0` base (`35746a7c`) briefly dropped the widgets/monthly-tracker from live; I immediately
    redeployed from the **latest committed `main`** (`f7920f34` = all committed work + my button), which is
    a strict superset — nothing lost. This deploy also brings live the already-committed, held-back
    rent-steps warning badge (`LeaseNewPage.js`), which is now safe since all sessions' work is committed.
  - Built + deployed from an isolated `git worktree` at `origin/main` (no session's uncommitted WIP), and
    committed only my two files + the test.

- **2026-07-01** — Database catch-up (migrations `0034`–`0038`) + monthly rent tracker. DB: Supabase
  `awgrjmbcghdjgnqeiqkt` — all 5 pending migrations applied via `supabase db push`. My deploy was
  Cloudflare `fb694246`; the live frontend has since rolled forward to `f7920f34` (entry above), a
  superset that includes this tracker.
  - **Feature (this task):** a friendly *monthly* layer over the annual invoices/payments. Each tenant's
    lease page gets a "Monthly rent — FY {year}" strip of 12 boxes (year total ÷ 12); one click records a
    payment tagged with the new `payments.period_month` against that year's invoice (auto-created), so the
    balance/AR/dashboards update automatically. `PropertyFinancialsPage` gets a rent roll with a per-month
    **"mark all tenants paid"** bulk action. Follows the shared fiscal-year selector — each year resets on
    its own. Files: `MonthlyRentTracker.js`, `PropertyRentRoll.js`, `api.js` helpers, `App.css`, migration
    `0037_payment_month.sql` (nullable `period_month`, additive). Committed as `5c4dabf`.
  - **The DB was 5 migrations behind the code** (`0034`–`0038`): several other sessions' feature screens
    (renewal-decision timing, assignment/history, dashboard Display settings) were already live but missing
    their database pieces. George OK'd bringing the DB fully up to date — `supabase db push` applied all 5
    (all additive/non-destructive; idempotent guards skipped objects that already existed). This repaired
    those features and enabled the rent tracker.
  - Committed only this task's files (staged just my `api.js` hunk).

- **2026-07-01** — Fix $/SF rent steps computed wrong on lease import. Deployed: `extract-lease` edge
  function (Supabase `awgrjmbcghdjgnqeiqkt`). **Frontend NOT pushed to Cloudflare** — see note below.
  - **Root cause (Gzim Mila lease):** the design has the model read RAW rent figures + a basis and the
    code do the math (`annualRentFrom`). Years 4-5 are written ONLY as a $/SF rate ($16.17, $16.97/sf);
    the model returned dollar amounts it multiplied itself ($17,478.72, $18,499.92 — inconsistent, they
    imply 1,081 and 1,090 sf, not the lease's 1,077), so the code's safety net had nothing to correct.
    Correct steps are $17,415.09 / $18,276.69.
  - **Fix:** hardened `SUPPLEMENT_SYSTEM` so a $/SF-only period is returned as the raw rate
    (`per_sqft_year`), never pre-multiplied — each row classified independently (mixed dollar/$SF
    schedules are normal). Added `square_footage` to `SUPPLEMENT_SCHEMA` as a fallback sqft so a $/SF row
    is never dropped for want of a size. Extracted the rent math to a shared, dependency-free
    `supabase/functions/_shared/rentSchedule.js` (`annualRentFrom` + new `rebuildRentSchedule`) so the
    edge function and a Jest test share ONE source; `extract-lease/index.ts` now calls it. The rebuild
    cross-checks the code's exact figure against the model's OWN `new_base_rent` and sets
    `parsed.rent_schedule_flag` on a wide gap (or an unresolvable $/SF row).
  - **Review screen** (`src/pages/LeaseNewPage.js` `SchedulePreview`): shows a "double-check these
    amounts" warning badge when `rent_schedule_flag` is set.
  - Verified token-free: new `src/lib/__tests__/rentScheduleSqft.test.js` replays the Gzim $/SF table —
    base $16,584, steps land exactly on $17,415.09 / $18,276.69, and the flag fires on the bad model
    math / missing-sqft cases. Full suite 16/16 green; `CI=true` frontend build compiles.
  - **NOTE for George — frontend held back:** the working tree carries another session's in-progress
    edits (`src/lib/api.js`, `emailTemplates.js`, `pages/DashboardPage.js`, `renewalEmails.test.js`), so a
    Cloudflare build would push their unfinished work live. The actual rent-math fix is 100% in the edge
    function and is already LIVE; the only frontend piece is the inert warning badge. Deploy the frontend
    (`CI=true npx react-scripts build` → `npx wrangler deploy`) once that session's work is ready, or tell
    me to push it. Committed only this task's files.

- **2026-07-01** — Hide/show dashboard widgets: new **Display** settings page. Deployed: DB migration
  `0038` (`user_preferences` table, applied via `supabase db query`), frontend Cloudflare version
  `8a06310e`.
  - **What it does for George:** on the Overview page he can now hide any of the six widgets he doesn't
    want — the four top cards (Annual rent roll, **Outstanding/receivables**, Occupancy, Expiring ≤ 90
    days) and the two panels (Lease expirations table, Alerts & notifications). Choices live in a new
    **Display** page in the sidebar footer (slider icon, next to Security) and are saved to his account,
    so they follow him across devices.
  - **New:** `src/pages/DisplaySettings.js` (the toggle page), `src/lib/dashboardWidgets.js` (shared
    widget keys/labels), `supabase/migrations/0038_dashboard_prefs.sql` (per-user `user_preferences`
    table, client-writable under RLS — same shape as `alert_states`).
  - **Edited:** `src/lib/api.js` (`getHiddenWidgets`/`setHiddenWidgets`), `src/pages/DashboardPage.js`
    (each widget gated by `show(key)`; the receivables query is skipped via `enabled` when its card is
    hidden; panels collapse to full-width when only one shows), `src/App.js` (route `/display`),
    `src/components/Sidebar.js` (nav item), `src/components/icons.js` (`SlidersIcon`). Prefs shared via
    React Query key `['dashboardPrefs']`. UI-verified end-to-end (hide receivables → card gone; hide a
    panel → other goes full-width; re-check → all back; zero console errors).
  - **Shared-file note:** `src/lib/api.js` and `src/pages/DashboardPage.js` also carried two other
    sessions' uncommitted WIP (monthly-rent tracking block in api.js; an `onSent` renewal tweak in
    DashboardPage). Deployed from an isolated `git worktree` at HEAD holding **only** my changes
    (symlinked node_modules), so their work was never bundled or touched. Committed only my hunks to the
    two shared files (via clean patches) plus my own files — their WIP left untouched in the tree.

- **2026-07-01** — Tenant renewal emails (approaching / renewed / not-renewed). Frontend-only,
  Cloudflare version `28324d8e`. No migrations, no edge functions. All three letters are generated in
  code (no AI cost) and sent by the landlord via the existing bell modal (Gmail/mail app) — nothing
  auto-sends.
  - `src/lib/emailTemplates.js` — two new letter builders on the shared `letter()` scaffold:
    `buildRenewalApproachingEmail` (a "your renewal is coming up" heads-up, with the option's term/rent
    and the notice-by date if stated) and `buildNonRenewalEmail` (a neutral lease-end / non-renewal
    notice). The "renewed" letter (`buildRenewalEmail`) already existed and is unchanged.
  - `src/lib/api.js` — `promptDueRenewalDecisions` now attaches the *approaching* email to the
    `renewal_decision` prompt (populates `email_*`), and **enriches a bare prompt** the SQL cron
    (`apply_due_renewals`) drops with no email — patches once, never duplicates. `declineRenewal` now
    drops a `renewal_declined` notification carrying the non-renewal letter (mirrors how `confirmRenewal`
    carries the renewed letter). `restoreRenewal` (undo) deletes that stale `renewal_declined` notice.
  - `src/pages/DashboardPage.js` — the email modal's "Mark sent" no longer dismisses a `renewal_decision`
    prompt (the Yes/No decision stays open after sending the heads-up); terminal notices still dismiss.
  - No DB change: `notifications.kind` is free text (`0007`), so `renewal_declined` needs no migration.
  - Verified token-free: new `src/lib/__tests__/renewalEmails.test.js` (4 tests) replays a due lease —
    approaching email on the prompt, bare-prompt enrichment (no dup), renewed email on confirm,
    non-renewal email on decline, and undo cleanup. All green.
  - Note: another session had heavy uncommitted WIP in the shared tree (dashboard widgets / Display
    Settings / monthly rent tracker, migrations `0037`/`0038`) intermixed in `api.js` + `DashboardPage.js`.
    Deployed from an isolated `git worktree` at `origin/main` with only my renewal-email changes
    re-applied (symlinked node_modules) — the other session's work was never bundled, touched, or shipped,
    and their migrations were not run.

- **2026-07-01** — Renewal "New rent" column formatting. Frontend Cloudflare version `69672db8`.
  - `src/components/RenewalOptionsEditor.js` — the +%/yr estimate was one cramped string in a
    right-aligned tabular-number cell; split into a main amount (`≈ $X`) with `+%/yr` on a `.cell-sub`
    line. Flat rents unchanged.
  - Note: another session had uncommitted WIP in the tree (renewal emails, dashboard widgets, Display
    Settings, migrations 0037/0038). Committed only `RenewalOptionsEditor.js`, and deployed from an
    isolated `git worktree` checkout of HEAD (symlinked node_modules, copied `.env.local`) so the build
    shipped **only** committed code — the other session's work was never bundled or touched.

- **2026-07-01** — Addendums follow-ups: assistant sees the whole lease, undo declines, renewal polish.
  Deployed: DB migration `0036`, `ask-lease` edge function (Supabase `awgrjmbcghdjgnqeiqkt`), frontend
  Cloudflare version `43616e53`.
  - **Assistant now reads original + riders + current phase.** New `src/lib/leaseContext.js`
    `buildLeaseAskContext({lease, renewals, addendums})` assembles a CURRENT PHASE summary (authoritative
    today) + the ORIGINAL LEASE text + every AMENDMENT (chronological). `LeaseAssistant.js` gains an
    `askContext` prop the AI reasons over, while the editable/save box still binds to `lease_text` only.
    `LeaseDetailPage.js` fetches addendums and passes it (+ a hint line). `ask-lease/index.ts` system
    prompt updated to treat current-phase/later-amendments as authoritative and pending options as
    not-yet-exercised. Unit-tested via `src/lib/__tests__/leaseContext.test.js`.
  - **Undo a declined renewal** — `restoreRenewal(id)` (api.js) puts an option back to pending, logs a
    `renewal_reopened` event, and re-raises the decision prompt if still due. UI: **↩ Undo** on a Declined
    row (`RenewalOptionsEditor.js`) and a transient **"Marked … not renewing · Undo"** banner on the
    dashboard right after clicking No (`DashboardPage.js`; `declineRenewalForLease` now returns the id).
  - **Renewal polish**: `renewalRent()` uses a new whole-dollar `money0()` (`format.js`) for both the flat
    and +%/yr cases (was cents-vs-no-cents); the dense helper became a 4-item bulleted list; the "build
    your lease in layers" note added to the Addendums section.
  - **Prompt timing**: the "Is the tenant renewing?" prompt now opens ~3 months before term end (was 6),
    or at the notice-by date — `isRenewalDecisionDue` (api.js) + SQL cron in migration `0036`. The verified
    ready-to-send renewal email (subject + letter body + recipient) confirmed populating in demo.

- **2026-07-01** — Addendums Phase 2+3: AI-led multi-effect review, tenant assignments, per-building
  history. Deployed: DB migration `0035`, `extract-addendum` edge function (Supabase
  `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `d8c133f4`.
  - **Assignment detection** (`supabase/functions/extract-addendum/index.ts`): the main schema is at
    Anthropic's 16-union ceiling, so a change-of-tenant ("Assignment and Assumption of Lease") is read
    by an **isolated, non-fatal second Haiku call** (`ASSIGNMENT_SCHEMA` — new tenant name/contact/
    email(s) + effective date; `is_assignment` is a plain boolean, not union-typed). Adds one cheap
    call per addendum upload only; if it fails the term/rent/renewal fields still return.
  - **AI-led multi-effect review** (`src/components/AddendumEditor.js`): replaced the single "This
    addendum…" picker with toggleable effect cards — Extends term / Changes rent (dated step rows) /
    Adds renewal option (now **pre-filled**, framed as *Pending — won't change your term until you
    confirm*) / **Assigns to a new tenant**. The AI pre-ticks + fills everything it found; each card
    is the override. A single addendum can now apply several effects at once.
  - **Apply** (`src/lib/api.js` `applyAddendum`): an assignment swaps `tenant_name`/`contact`/emails on
    the lease and logs the prior tenant. Also logs `term_extended`, and `confirmRenewal`/
    `declineRenewal` log `renewal_confirmed`/`renewal_declined`.
  - **Per-building history** (migration `0035` `history_events` table + `kind='assignment'`;
    `src/pages/HistoryPage.js` new "Lease & tenant history" timeline). New `logHistoryEvent` /
    `listHistoryEvents` in api.js.
  - Verified token-free: `addendumRenewalReplay.test.js` now also replays the D&D Dental assignment —
    tenant swaps to D&D Dental, term stays 2026, prior tenant preserved in history. UI smoke-test
    passed (effect cards toggle, assignment changes the tenant, timeline shows the event, added option
    is Pending & term-neutral, zero console errors).
  - **Live data corrected** (lease `2258272a`): tenant → **D & D Dental, LLC / Dr. Ahmed Hegazy** with a
    `tenant_assigned` history event (eff Aug 1 2021); the assignment addendum reclassified `kind=
    'assignment'`. Left `tenant_email`/`2` untouched (no D&D email in the doc — George can add it).

- **2026-07-01** — Addendums Phase 1: renewal options no longer auto-extend the term. Deployed:
  DB migration `0034`, frontend Cloudflare version `86be8d83`. (Phase 2 = assignment/tenant
  detection + multi-effect review; Phase 3 = per-building history — both still to come. Plan file:
  `~/.claude/plans/couple-things-for-the-happy-kay.md`.)
  - **Root bug:** the app stored a committed *extension* and an optional *renewal* in the same
    `renewal_options` bucket, and `resolveCurrentTerm` chained every **pending** option into the
    term — so an un-exercised option pushed `lease_termination_date` into the future (George's lease
    read 2031 instead of 2026) and options auto-stamped "Applied" with a phantom duplicate row.
  - `src/lib/leaseTerm.js` — `resolveCurrentTerm` no longer chains renewal options at all; the
    lease's own dates are the committed term. `src/lib/api.js` — `applyAddendum` now moves the term
    **directly** for an extension (+ lays its opening rent in as a dated step) and never creates an
    extension-as-renewal row; renewals insert `pending` and are term-neutral.
  - **No more silent auto-apply.** `applyDueRenewals` → `promptDueRenewalDecisions` (and the SQL
    cron `apply_due_renewals` in migration `0034`) now drop a one-time `renewal_decision`
    notification ("Is [tenant] renewing?") when a decision is due (notice-by date, else ~6mo before
    term end). New `confirmRenewal`/`declineRenewal` (+ `…ForLease` bell helpers) apply or close it;
    Yes/No buttons in the Dashboard bell (`DashboardPage.js`) and Renew/Not-renewing on the lease
    (`RenewalOptionsEditor.js`, status now pending/applied/declined). `Layout.js` calls the prompt;
    `LeaseDetailPage.js` copy updated. Migration `0034` also allows `status='declined'`.
  - Verified token-free: `src/lib/__tests__/addendumRenewalReplay.test.js` replays George's real
    Vibhakar docs through the fixed pipeline — term holds at 2026 with the option Pending; confirming
    rolls it to 2031. UI smoke-test passed (pending≠extend; Renew extends; bell prompt renders).
  - **Live data corrected** (lease `2258272a`): removed the phantom 180-mo renewal row, restored the
    trapped Oct-2021 $43,128 escalation step, set the real Section 4 option back to `pending`, and
    pulled the committed term back to `2026-09-30`. NOTE for George: there's a second, already-correct
    lease for this space (`Kamal Vibhakar`, term 2026) — possible duplicate, left untouched.

- **2026-06-30** — Lease rent accuracy + review-form alignment. Deployed: `extract-lease` edge
  function (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `fe17b9e1`.
  - Rent was off by cents and step-ups were wrong because the model did the arithmetic. The
    isolated supplement call now reads the whole **rent_schedule** (one row per period: raw amount
    + basis + effective date) and `annualRentFrom()` computes every annual figure in code, to the
    **cent** — base rent = earliest period, later periods become the (manual) escalations. Main
    lease `SCHEMA` still untouched; supplement stays non-fatal. (`supabase/functions/extract-lease/index.ts`)
  - `src/components/LeaseForm.js` — field labels reserve a constant height so the AI confidence
    badge no longer pushes a field's input box below its un-badged neighbours.
  - Follow-up (frontend Cloudflare version `fdd9685b`): shortened the long "Tax/CAM share override
    (%) — blank = pro-rata by SF" label (it wrapped and misaligned its box) to just "Tax/CAM share
    override (%)" and moved "Blank = pro-rata by SF" into a `hint` note under the input; `Field` now
    takes an optional `hint` prop.

- **2026-06-30** — Two tenant emails + contact/email extraction. Deployed: DB migration `0033`,
  `extract-lease` edge function (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `692cbb61`.
  - A lease can now hold **two** emails (primary + secondary). Anywhere a tenant email is sent —
    Invoice, the bell renewal/escalation email, the "Email tenant" box — a **Primary / Second / Both**
    picker appears when a second email exists (defaults to primary; "Both" comma-joins). One email = the
    old plain field, unchanged. The daily reminder cron only emails the owner, so it's untouched.
  - `migration 0033` — `leases.tenant_email_2`, `notifications.email_to_2`, recreated `v_tenant_shares`
    with `tenant_email_2`, extended the `fill_notification_recipient` trigger to carry the 2nd email.
  - New `src/components/RecipientField.js` (the picker); wired into `InvoiceButton.js`,
    `EmailComposeModal.js`, `NotificationEmailModal.js`. Edit UI in `LeaseForm.js` + `LeaseDetailPage.js`;
    plumbing in `lib/api.js` + demo `store.js`/`mockClient.js`.
  - `extract-lease/index.ts` — now also extracts `tenant_contact_name` + two tenant-side emails (primary
    first, never the landlord's). Added a non-nullable `strField()` so the 3 new fields cost **zero**
    union-typed params — the schema was already at Anthropic's hard 16-union structured-output limit; a
    17th would 400 every extraction. `LeaseNewPage.js` maps the new fields onto the review form.
  - Note: committed only this task's files. Left `CLAUDE.md` (carries another session's pending
    status-line standing instruction + their deploy-log entries) uncommitted — flagged to George.

- **2026-06-30** — Lease upload copy tweak. Deployed: frontend Cloudflare version `19f713ec`.
  - `src/components/LeaseUpload.js` — added a one-line note under "Add a lease with AI": "Word docs and
    PDFs give the fastest, most accurate read — scans and photos work great too" (positively framed so
    scans/photos don't read as second-rate); removed the obsolete "if the file dialog doesn't open…" tip.
  - Note: the Cloudflare build was taken from the working tree, which also carried another session's
    in-progress frontend edits (`EmailComposeModal.js`, `InsuranceVault.js`, `InvoiceButton.js`,
    `LeaseForm.js`, `NotificationEmailModal.js`, `lib/api.js`, `LeaseDetailPage.js`, new
    `RecipientField.js`) — not my task; flagged to George. Committed only `LeaseUpload.js`.

- **2026-06-30** — Fix scanned-PDF AI extraction (was failing with "Edge Function returned a
  non-2xx status code"). Deployed: edge functions `extract-lease`, `extract-insurance`,
  `extract-contract`, `extract-addendum` (Supabase `awgrjmbcghdjgnqeiqkt`); frontend Cloudflare
  version `e9fad0ae`.
  - Root cause: the vision fallback asked the model to transcribe the whole document into a
    structured-output field capped at 8192 tokens, so real multi-page scans truncated → invalid
    JSON → 500. Split into two reads: a constrained fields-only call (reliable, small) + a
    separate best-effort transcription call that can't truncate the fields.
  - `functions/_shared/anthropic.ts` — new `transcribeDocument()` (non-fatal, its own call) and
    `MAX_VISION_BYTES` (20 MB guard with a friendly message past it).
  - The four `extract-*/index.ts` — vision branch now uses fields-only `SCHEMA`/`SYSTEM_FIELDS`,
    size guard, then `transcribeDocument()` for the searchable copy (George chose to keep it,
    costs a 2nd AI read per scan). Removed the unused `SCHEMA_VISION`/`SYSTEM_VISION`.
  - `src/lib/supabaseClient.js` — `invokeFunction` now reads the function's JSON `{ error }` body
    so real messages surface instead of the generic "non-2xx".
  - Note: the Cloudflare build was taken from the working tree, which also carried unrelated
    in-progress edits to `App.css`, `Sidebar.js`, `icons.js` (not my task) — flagged to George.

- **2026-06-30** — Insurance overhaul. Deployed: DB migrations `0031`+`0032`, `send-reminders` edge
  function, frontend Cloudflare version `5ca45592`.
  - Removed cost/token wording from user-facing copy (`InsuranceVault.js`, `lib/demo/mockClient.js`).
  - Landlord insurance is now property-only — removed from the lease level
    (`pages/LeaseDetailPage.js`, `PropertyInsuranceModal.js`).
  - Extra documents per policy + a Premium field; **Remove policy → Save to history** (archive) with an
    "Expired & archived" list (`InsuranceVault.js`, `lib/api.js`, migration `0032`).
  - Insurance expiry: in-app alerts already existed (wording tweak in `lib/alerts.js`); added owner
    **email** reminders with per-threshold dedupe (`functions/send-reminders/index.ts`).
  - Note: migration `0031` (beta account cap) was also applied — it was pending on the remote and is
    idempotent, so it just re-established the intended 2-account cap.

- **2026-06-30** — Invoice email redesign + cross-account cache fix. Cloudflare version `45fb280b`.
  - `src/lib/invoiceTemplate.js` — removed the "Notes" section, cleaner letterhead/header
    (right-aligned invoice no., two-line date/due), renamed the total row to **AMOUNT DUE**,
    kept all four detail columns (monthly / annual / $·SF·mo / $·SF·yr). No AI involved.
  - `src/context/AuthContext.js` — clear the React Query cache when the signed-in user
    changes, so one account's data no longer lingers under the next.
  - `src/components/Sidebar.js` — clear cached data instantly on sign-out.
