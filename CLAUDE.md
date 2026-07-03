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

- **2026-07-03** — New Hong Kong 2: the 2%/yr prose escalation now actually lands as yearly steps.
  Deployed: `extract-lease` edge function (Supabase `awgrjmbcghdjgnqeiqkt`). **No frontend deploy**
  (fix is entirely edge-side; the review form already dates + saves the steps), no migration, no
  money (re-extraction is George's own upload).
  - **What George reported (correctly, this time it's a real bug):** he uploaded a copy that DOES
    contain "Base rent will increase annually by 2% and will be renegotiated in the 8th year" (the
    `New Hong Kong 2 (1).docx` / `.pdf` — 3.64 MB, byte-identical to `Downloads/New Hong Kong 2.pdf`;
    the *without*-clause copy is the 3.9 MB `NASA/Leases/Hong Kong/New Hong Kong 2.pdf`). The app
    "reads it but can't implement the yearly escalation in the rent escalations tab."
  - **Root cause (found in the stored `extraction_raw`, id `f85a9dcd`):** Haiku DID capture
    `escalation_pct=2`, `escalation_stop_months=84`, `term_months=120`, base `$22,848` — everything
    `percentEscalations` needs for 6 steps. But the lease prints the SAME base rent two ways ("$21.00
    PSf" **and** "Monthly Base Rent: $1904.00"), so Haiku returned TWO `rent_schedule` rows both at
    `months_from_start:0`. `rebuildRentSchedule` treated the second as a step-up → one bogus escalation
    of $22,848 at month 0 → escalations looked "non-empty" → the guard that only synthesizes the
    prose-%/yr steps when there are NO real step rows was tripped, so the 2% formula never ran. The
    stored escalations were exactly `[{months_from_start:0, new_base_rent:22848, manual}]` (and the
    disagreement alarm stayed silent because that degenerate row counts as "a step"). So: read fine,
    dropped by a dedupe gap — matches George's symptom exactly.
  - **Fix A (the real fix) — collapse same-period rows** (`_shared/rentSchedule.js`): before splitting
    base vs steps, group rows by period identity (printed date if any, else month offset) and keep the
    most reliable one (resolvable > unresolvable; plain-dollar > $/SF). Two rows at offset 0 collapse to
    one → escalations empty → the 2% formula fires → 6 steps ($23,304.96 … $25,730.56, months 12–72).
    Rows at genuinely different offsets/dates (real graduated tables — Wingstop/Gzim/Ricki's) have
    distinct keys and never merge. Superseded $/SF row no longer raises a false "missing sqft" flag.
  - **Fix B (robustness) — analyst-fed percent fallback** (`extract-lease/index.ts`,
    `_shared/analystVerdicts.js`): the same clause read differently across George's repeat uploads —
    one got `pct=null` (Haiku missed it entirely), another `stop=96` (wrong). So the Sonnet analyst's
    VERDICTS line now also emits `escalation_pct` + `escalation_stop_months`; the parser captures
    numeric values; and the merge uses them as a FALLBACK when Haiku's supplement comes up empty
    (Haiku still wins when present → no regression). The strong reader that nails the clause now feeds
    the implementation, not just a yes/no. Verdicts parsed once and reused for the disagreement alarm.
  - Verified token-free: `percentEscalationClause.test.js` +2 (the dup-row New Hong Kong case → 6
    percent steps, order-independent, no false flag) and `analystVerdicts.test.js` +2 (numeric verdict
    parsing incl. "none"). Full suite **122/122 green**; edge fn deployed clean (Deno bundled the shared
    modules). Committed only this task's files. **Live check:** re-upload `New Hong Kong 2 (1).docx`
    (~10–15¢) — expect base $22,848/yr and six 2% steps in the Rent escalations tab (dated from the
    2017-06-01 start), NOT a single month-0 row.

- **2026-07-03** — Universal "extraction disagreement alarm" — when the AI analyst read finds a
  term the form-filler dropped, warn instead of silently showing nothing. Deployed:
  `extract-lease` edge function (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version
  `763b9e72`. No migration. No new AI call (the analyst pass already runs); adds ~20 tokens/lease.
  - **What George caught (New Hong Kong 2):** he re-uploaded the lease and got NO 2% escalation even
    after the Sonnet analyst work shipped earlier today, and insisted the sentence is "literally in
    the PDF." **Root cause was a file mix-up, not the extractor:** George has TWO near-identical copies
    under the same name. The **July 2** copy has *"Base rent will increase annually by 2% and will be
    renegotiated in the 8th year"* at the end of §1 RENT; the copy he **re-uploaded today** (and the
    one attached to the chat) does NOT — §1 ends at "…may designate in writing." I pixel-verified both
    scans (rendered page 2 of each stored PDF via macOS PDFKit) and diffed both docx text layers: byte
    sizes differ (WITH clause = 3.6 MB pdf / 36 KB docx; without = 3.9 MB / 33 KB) and the ONLY textual
    difference is that one sentence. The Sonnet analyst DID run on today's upload and correctly reported
    "no base-rent escalation stated"; the only % in that file is the §4 103% CAM cap (not a base-rent
    escalation). So the extractor behaved correctly on BOTH files — it was handed the copy without the
    clause. Put the correct copies on George's Desktop as `New Hong Kong 2 — WITH escalation clause.pdf`
    / `.docx` (pulled from the app's own July-2 storage).
  - **The universal fix George asked for** (so this can't silently happen on any hard-to-read lease,
    not just this one) — a three-layer safety net:
    - **1) Analyst verdicts.** `ANALYST_SYSTEM` now ends every brief with a machine-readable line:
      `VERDICTS: escalation=<yes|no|unclear>; renewal_options=…; abatement=…; start_date=<stated|not_stated>`,
      with explicit guidance that a CAM/Additional-Rent cap is NOT a base-rent escalation and an
      "Option to Extend: None" is renewal_options=no.
    - **2) Disagreement alarm.** New pure `_shared/analystVerdicts.js` (`parseAnalystVerdicts` +
      `extractionMismatches`, Deno+Jest dual-use like `rentSchedule.js`). After the form calls,
      `extract-lease` compares each affirmed verdict against what actually landed: analyst says
      escalation=yes but no steps AND no % captured → flag `escalation`; same for `renewal_options` /
      `abatement`. Flags stored as `extraction_mismatch` on `extraction_raw` (no migration). Only
      **yes** + empty flags — `no`/`unclear`/missing-line never cry wolf, so it degrades to prior
      behavior when the analyst times out. Catches BOTH failure classes: prose clauses the rigid form
      can't hold, and messy scans where strong Sonnet sees a term cheap Haiku misses.
    - **3) Review screen explains itself** (`LeaseNewPage.js SchedulePreview`): a strong ⚠ banner when
      `extraction_mismatch` is set ("the analyst found X but it wasn't captured — add it or re-upload");
      the vague "no steps detected" warning is replaced, when a brief exists, by an honest "the analyst
      read the whole document and found no rent escalation stated — check you uploaded the right file";
      and a collapsible **"Read the AI analyst's notes"** panel on every import with a brief (VERDICTS
      line stripped) so the chat-quality read is visible before saving. `extraction` already flows
      untouched to the review screen — no new plumbing. Mismatch labels mirrored inline (CRA can't
      import across into `supabase/functions`).
  - Verified token-free: new `src/lib/__tests__/analystVerdicts.test.js` (16 cases — verdict parsing incl.
    markdown/last-occurrence/junk; escalation=yes+empty flags, +%/+steps/+relative-steps don't; no/unclear/
    missing never flag; options + abatement; multi-flag; New Hong Kong both-copies end-to-end). Full suite
    **118/118 green**; `CI=true` build compiles (+503 B). Edge fn deployed clean (Deno bundled the new
    shared module). Committed only this task's files. **Live check pending:** import the Desktop
    `…WITH escalation clause.docx` (~10–15¢) — expect base $22,848/yr, six 2% steps (months 12–72,
    $23,304.96…$25,730.56), the year-8 renegotiation note, the analyst-notes panel, and NO mismatch warning.

- **2026-07-03** — Make the property summary "$/SF" rate cards divide by the entered **building
  size**, not leased SF (finishes what `0042` started for the per-tenant bills). Deployed: DB
  migration `0044` (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `a19be56a`. No edge
  functions, no money, no tenant emails, no destructive data.
  - **What George caught:** the Financials page's **"CAM / maintenance — charged per sq ft"** and
    **"Property taxes"** cards read `cam_psf`/`tax_psf` from `v_property_totals`, which `0042` never
    updated — so those headline rates still divided by **leased** SF and read *higher* than what each
    tenant is actually billed just below (e.g. CAM 7,320 ÷ 11,791 leased = $0.62 shown vs. 7,320 ÷
    13,750 building = $0.53 billed). George's framing: keep it codebase-generic, works for **every**
    account, and re-divide **every time** the building size changes.
  - **1) `0044_property_totals_building_sf.sql`** recreates `v_property_totals` identical to 0021
    except `tax_psf`, `cam_psf`, and the roof `roof_recovered`/`roof_unrecovered` split now use the
    building-first divisor `coalesce(nullif(p.building_sf,0), ls.total_sf)` — mirroring 0042 exactly, so
    the summary matches `v_tenant_shares`. Falls back to leased SF until a building size is entered;
    `roof_psf_rate` and the page's revenue/expense "per **leased** sq ft" figures deliberately left
    leased-based. `security_invoker` re-asserted; non-destructive create-or-replace. (Named `0044`
    because another session already shipped `0043_enabled_features.sql`.)
  - **2) Re-divide on change** — `BuildingSizeEditor.js` `onSuccess` now also invalidates
    `['tenantShares', propId]`, `['propertyRentRoll', propId]`, `['monthlyRent']` (plus the existing
    property/propertyTotals/leases keys), so the rate cards, per-tenant breakdown, invoices, and rent
    roll all recompute the instant the size is saved — no reload.
  - **3) Per-tenant breakdown total** — `TenantShareTable.js` already had a Totals row summing every
    tenant's SF; added a sub-line ("of N building") and a reconciliation note that the leased total may
    differ from the building size (the difference is vacant space), for the landlord to reconcile.
  - **4) Demo parity** — `mockClient.js propertyTotals()` now divides `tax_psf`/`cam_psf`/`roofRecovered`
    by `buildingSf` too, matching the live view.
  - Verified: new assertions in `contractCam.test.js` (building-SF → cam_psf/tax_psf; leased-SF
    fallback). Full suite **102/102 green**; `CI=true` build compiles. Live check confirmed
    `cam_psf × building_sf = cam_total` and `tax_psf × building_sf = taxes_total` for every property
    with a building size. Committed only this task's files (left the untracked `.claude/` items alone).

- **2026-07-03** — Chat-quality lease reads: an "analyst read" stage + prose rent-escalation
  clauses ("Base rent will increase annually by 2%"). Deployed: `extract-lease` edge function
  (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `c2bbe895`. No migration.
  **Costs money:** the new analyst read runs on **Sonnet 4.6**, adding **~10–15¢ per lease import**
  (George approved). Form-filling stays on Haiku; a few leases/month → well under $2/mo.
  - **What George saw (New Hong Kong 2.pdf):** import got start/end/term right but produced NO rent
    escalation — the lease's only escalation language is one prose sentence ("Base rent will increase
    annually by 2% and will be renegotiated in the 8th year"; §1, p.2). Pasting the same lease into a
    regular AI chat reads it perfectly. He asked why the app can't match that.
  - **Root causes (compounding):** (1) every extraction call uses **structured output** — the model
    must emit the rigid form directly, no chat-style reasoning first; (2) the 16-union ceiling forced
    the read into three narrow schema-locked calls, none reading holistically; (3) the supplement's
    `rent_schedule` only accepted discrete rent **rows** — a prose formula had **no field to land in**,
    so it was silently dropped (no model, however smart, can output what the form can't hold).
    Everything downstream already supported it (`rent_escalations.escalation_type='percent'` (0001),
    `computeEscalatedRent` compounding, `buildEscalations` dating `months_from_start`) — only the
    reader was missing the concept.
  - **Fix A — analyst read (the structural fix).** `extract-lease/index.ts`: a NEW first pass
    (`analystRead`, `ANALYST_MODEL='claude-sonnet-4-6'`, plain text / NO schema so it can reason like
    chat, `effort:'medium'`, **best-effort + time-boxed 60s + non-fatal**) writes a factual brief
    (parties · term & dates: signing-vs-commencement · full rent progression incl. **prose escalation
    formulas + where they stop** · renewal options · abatements). The two Haiku form-fillers then run
    concurrently with the brief appended (`briefBlock`) so they inherit its interpretation of tricky
    dates/terms while still quoting the document themselves ("if the brief and the document disagree,
    trust the document"). Sequencing preserves the 546-timeout fix: transcription starts first (90s
    cap), analyst awaited (≤60s), then the two form calls in parallel (~30s) — well under the 150s
    edge ceiling. Brief persisted to `extraction_raw.analysis_brief` for audit. **No prompt caching**
    — infeasible here (Sonnet analyst vs Haiku forms = model-specific caches can't share); Sonnet cost
    is George-approved instead.
  - **Fix B — prose escalation formula gets a home.** `SUPPLEMENT_SCHEMA` gains `escalation_pct` +
    `escalation_stop_months` (both `field()`-wrapped → schema now 15/16 unions, main SCHEMA untouched).
    New prompt paragraph: read the % + where it stops, never compute. New pure helper
    `percentEscalations(baseAnnual, pct, termMonths, stopMonths)` (`_shared/rentSchedule.js`)
    synthesizes one **percent** step per lease year, compounded round-each-step to the cent (matches
    `computeEscalatedRent`). Wired into `rebuildRentSchedule` — applied ONLY when the printed schedule
    prices ≤1 period (**a real rent TABLE always wins**; Wingstop/Ricki's regressions safe) — plus a
    merge-block fallback off the model's own base_rent when the supplement priced no row. New Hong
    Kong: base $1,904/mo → $22,848/yr; six 2% steps months 12–72 ($23,304.96 … $25,730.56, years
    2–7); nothing past month 84 (renegotiated). Extraction stamps `rent_escalation_pct` /
    `rent_renegotiation_months` onto the read for the UI.
  - **Frontend (notes only; existing machinery dates & saves the steps):** `LeaseNewPage`
    SchedulePreview shows "↗ raises base rent 2%/yr — N yearly steps" + the renegotiation note;
    `LeaseDetailPage` shows a self-clearing "💬 Rent was set to be renegotiated ({date})" reminder
    once that date passes and no step covers it (reads `extraction_raw` via a self-contained
    `supabase` query, NOT `api.js`). **Zero changes to `api.js`/`leaseTerm.js`/EscalationScheduleEditor**
    (other sessions' modified files) — my steps ride their existing functions unchanged.
  - Verified token-free: new `src/lib/__tests__/percentEscalationClause.test.js` (9 tests) replays the
    New Hong Kong shape — `percentEscalations` → 6 compounded steps; table-wins regression; pct-null =
    unchanged; `buildEscalations` dates them 2018-06-01…2023-06-01. Full suite **100/100 green**;
    `CI=true` build compiles; edge fn deployed clean (Deno accepted the TS). Committed only this task's
    files (`30d4d04`); built + deployed frontend from an isolated git worktree at that commit so no
    other session's uncommitted WIP shipped. **Live check:** re-upload New Hong Kong 2.pdf (~25–35¢,
    scanned PDF through the Sonnet analyst) — expect base $22,848/yr, six 2% steps, the renegotiation
    note, and NO invented options (§27 "Option to Extend: None").

- **2026-07-03** — Remove the first-run onboarding picker. Deployed: frontend Cloudflare version
  `3d479b2d`. No migration, no edge functions, nothing that costs money.
  - **Why:** George didn't like the one-time Welcome screen. Settings alone is the place to pick
    features — Display & features first, Security & 2FA second — no upfront picker.
  - **What changed:** deleted `src/components/WelcomeOnboarding.js` and stripped its gate from
    `src/components/Layout.js` (removed the `['enabledFeatures']` onboarding query, the
    `needsOnboarding` flag, the `WelcomeOnboarding`/`getEnabledFeatures` imports, and the unused
    `useQuery` import — CI treats warnings as errors). Layout now always renders `children`.
  - **The switchboard core is untouched** and still works: `enabled_features` stays `null` for
    everyone until they toggle a module in Settings, and `isFeatureOn(null, …)` reads null as "on",
    so every feature shows by default (same result the pre-checked picker gave) — just without the
    intro screen. `features.js`, the api.js pair, and the Display & features toggles are unchanged.
  - Verified token-free: no remaining `WelcomeOnboarding` references; full suite **91/91 green**
    (features.test.js unchanged — it only tests the pure helpers); `CI=true` build compiles.
    Committed only this task's files (`Layout.js` + the deletion); left the other session's
    in-progress lease-extraction edits and the untracked `.claude/` items alone.

- **2026-07-03** — Feature switchboard (opt-in modules) + a real Settings page. Deployed: DB
  migration `0043` (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `9b971c06`. No
  edge functions, no AI calls, nothing that costs money. First round of a larger plan
  (`~/.claude/plans/can-you-do-a-structured-flask.md`) — this builds ONLY the foundation that
  makes features opt-in; the four coming modules (expenses, maintenance, deposits, paper-trail)
  each register into it later.
  - **Why:** George is about to add several feature modules but doesn't want to force them on
    anyone. Each user should pick what they want at first sign-in and add/remove features anytime.
    He also wanted the old standalone "Display" page turned into a **Settings** page we can grow,
    with "Display & features" as its first section.
  - **Data (one additive column):** `0043_enabled_features.sql` adds `enabled_features jsonb` to
    `user_preferences` (same per-user row as `hidden_widgets`, migration 0038; client-writable
    under the existing RLS). `null` = never chosen → show the onboarding picker + treat everything
    as on; an array = the explicit set of optional modules on. Turning a module off only hides it —
    data is never deleted. Only pending migration (0042 already remote), pushed alone via `db push`.
  - **Switchboard:** new `src/lib/features.js` — the `FEATURES` registry (`{key,label,hint}`,
    mirrors `dashboardWidgets.js`), pure helpers `isFeatureOn` (null/undefined → on) + `toggleFeature`
    (materializes the full set on first toggle-off), and a `useFeatures()` hook. api.js gained
    `getEnabledFeatures`/`setEnabledFeatures` mirroring the widget pair (returns `null` when unset,
    never `undefined`), cached under `['enabledFeatures']`. Optional modules live today: `insurance`,
    `contracts` (new ones append one line each when built).
  - **Onboarding (kept — George likes it):** new `src/components/WelcomeOnboarding.js`
    ("What should Amlak handle for you?", all pre-checked, Save or "Skip — keep everything on").
    Gated in `Layout.js`: when `enabled_features === null` (and not DEMO) it renders in place of the
    app; saving makes it non-null so it shows exactly once. Existing accounts (George + beta user)
    see it once, pre-checked to match today.
  - **Settings page:** new `src/pages/SettingsPage.js` — sections down the left (reusing
    `side-item`), content on the right via `<Outlet/>`. `App.js` nested `/settings` → index redirect
    to `display`, `/settings/display`, `/settings/security`; old `/display` + `/security` now
    `<Navigate>` redirects. `Sidebar.js` footer's two items collapse into one **Settings** item.
    `DisplaySettings.js` retitled "Display & features" and grew a **Features** toggle group
    (same row UI) above the existing widget/panel toggles — the single place to hide/restore both.
    `SecuritySettings.js` gained a "Settings › Security & 2FA" breadcrumb.
  - **Made the switch real on day one:** `useFeatures().isOn(...)` gates the two existing optional
    modules — Contracts (hide the tab in `PropertyTabs.js`, redirect the Contracts route when off)
    and Insurance (hide the property-card button in `PropertiesPage.js` + the tenant Insurance panel
    in `LeaseDetailPage.js`). `isOn` defaults on while loading, so nothing flash-hides.
  - Verified token-free: new `src/lib/__tests__/features.test.js` (null → all on; undefined → on;
    `[]` → all off; subset honored; first toggle-off materializes full set minus one; pure/no-mutate;
    unique keys). Full suite **91/91 green**; `CI=true` build compiles. Committed only this task's
    files (left the untracked `.claude/` items alone). Live check: fresh load shows the Welcome
    picker once; Settings shows the left rail with Display & features selected; toggle Contracts /
    Insurance off → their UI vanishes, back on → returns.

- **2026-07-03** — Five asks in one round: (1) bill CAM/taxes per SF of the WHOLE building,
  (2) show notifications up to 6 months ahead, (3) redesign the renewal-options table, (4) fix the
  broken "Renew" on a future option + stop un-exercised option rents reading as committed, (5)
  contract year-over-year escalations that auto-feed CAM, plus (6) contract-expiry reminders and a
  ✉ email button on every reminder. Deployed: DB migration `0042`, `extract-contract` edge function
  (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `f524e422`. No money, no tenant
  emails sent, no destructive data. No live-data repair needed.
  - **1) CAM/taxes per building SF** (`0042` recreates `v_tenant_shares` with denominator
    `coalesce(nullif(p.building_sf,0), pt.total_sf)`, `security_invoker` preserved; mirrored in
    `mockClient.js`). Each tenant now pays `their SF ÷ building SF` for tax/CAM/roof, so the vacant
    share stays with the landlord (standard net-lease practice) instead of being split across only the
    leased tenants. Falls back to the old leased-SF split until a building size is entered, so nothing
    breaks first. `TenantShareTable.js` shows a nudge to enter Building size when it's unset and the
    footer note reflects building-wide vs leased-only. Only one invoice exists (D&D Dental 2026, CAM/tax
    $0) so no bill repair; every downstream (draft-invoice, monthly tracker, rent roll, AR) reads the
    view → fixed automatically. **George: enter Harlem Plaza's building SF** (Pershing already 13,750).
  - **2) 6-month notifications** — `alerts.js bucket()` gains "Within 3 months" (warn) and "Within 6
    months" (info — calm, not red) bands; all alert types inherit. `isRenewalDecisionDue` +
    `apply_due_renewals()` (in `0042`) open the renewal prompt 6 months before term end (was 3).
    Dashboard "Expiring ≤ 6 months" card + "next 6 months" panel (was 90 days). Owner reminder EMAILS
    (`send-reminders`) keep their near-date schedule — untouched.
  - **3) Renewal table redesign** (`RenewalOptionsEditor.js` + new `.btn-sm`/`.btn-row` App.css
    classes) — Renew as a compact primary button, Not renewing / ✉ Email tenant as quiet secondary
    ones (no more inline 3px/12px styling); Term reads "60 mo (5 yr)"; Notice-by a real date or muted
    "—"; applied rows show "Applied · date".
  - **4) The "Renew" fix (root cause) + gating.** `rollLeaseIntoRenewal` (`api.js`) always moved
    `lease_start` to the old term end — right for catching up a PAST/lapsed option, but wrong for
    confirming a FUTURE option early: it pushed the start into the future and wiped today's rent, so the
    page looked unchanged (the Five Points Wings symptom). Now it branches on whether the option's
    window has begun: begun → today's catch-up behaviour (unchanged, keeps the other session's
    retro-chaining + `{newRent}` entry); future → **extend `lease_termination_date` only, leave
    `lease_start` + base rent alone, and lay the option's rent in as DATED steps** (skipping any the
    imported schedule already has within ±45 days, so no duplicate). Un-exercised option rents no longer
    pose as committed: steps dated on/after the committed term end are gated out of `applyDueEscalations`,
    `leaseTerm.js` (`nextStep` + the expired "last-known rent"), `alerts.js`, and shown in
    `EscalationScheduleEditor.js` as a muted "Pending renewal — if renewed" group that rejoins the
    schedule automatically once the renewal is confirmed. `reconcileRenewalOptions` untouched.
  - **5) Contracts → CAM.** New pure `src/lib/contracts.js` (`contractCoversYear` / `contractAnnualCost`
    — annualize by frequency, compound `escalation_pct` per year since start). `api.js
    syncContractCamItems(prop, year)` upserts one CAM line item per covering contract at the escalated
    amount (`contract_id` links it), refreshes drift, removes rows a contract no longer covers, re-sums
    the CAM total — idempotent, writes only on a real change. `CamSection.js` syncs-then-lists (opening
    any fiscal year self-heals it — the "fiscal-year carry-over"); contract rows show a "from contract"
    badge + no ✕. `ServiceContractsSection.js` gained Escalation %/yr + Vendor email fields (AI
    pre-fills them), a "+X%/yr · CAM {year}: $…" sub-line, and CAM-invalidating saves. `extract-contract`
    reads `escalation_pct` + `vendor_email` in the same single Haiku call (no new AI cost).
  - **6) Contract-expiry reminders + email on every reminder.** `buildAlerts` takes `contracts` →
    `focus:'contract'` alerts off `end_date` (same 6-month buckets), keyed by contract id; `fetchAlertData`
    fetches contracts; the dashboard row navigates to that property's Contracts tab. New `draftAlertEmail`
    (`api.js`) drafts the right letter per reminder — escalation → `buildEscalationEmail`, lease-ending →
    `buildNonRenewalEmail`, renewal → `buildRenewalApproachingEmail`, tenant insurance →
    `buildInsuranceRequestEmail`, contract → new `buildContractRenewalEmail` (to the vendor). Every alert
    row gets a ✉ button (except the landlord's own insurance — no outside recipient); sending does NOT
    dismiss the reminder. Owner-only send rule unchanged.
  - Verified token-free: new `contractCam.test.js`, `sixMonthAlerts.test.js`, `futureRenewalConfirm.test.js`
    (Ricki's future Option-3 confirm → term 2031→2036-05-01, `lease_start` stays 2015-05-01, rent stays
    $28,348.92, no duplicate 2031 step; leaseTerm gating; bucket 3m/6m; contract compounding + sync
    idempotency; per-building-SF shares; contract alerts + `draftAlertEmail` per type). Full suite
    **83/83 green**; `CI=true` build compiles. Committed only this task's files. **George: re-upload the
    Five Points Wings lease and its renewal chain will apply cleanly; enter Harlem Plaza's building SF.**

- **2026-07-02** — Wingstop round 3: use the signing date as the lease start + date the rent
  schedule from rent commencement (after the free period). Deployed: frontend Cloudflare version
  `22c33669`. **No edge function, no migration** — the deployed extractor already returns everything
  needed (execution_date, the abatement's month count, and unshifted lease-year offsets); the fix is
  entirely in how the app USES that read.
  - **What George saw:** re-uploaded Wingstop still came out wrong — the app "didn't identify the
    start date (May 4 2012)," "didn't account for the 8 months of free rent," and the rent steps
    "didn't correspond with the renewal options." Claude.ai / ChatGPT read it "on the dot."
  - **Root cause (my own, from rounds 1–2):** I had hardened the extractor + `LeaseForm` to REFUSE
    the "entered into as of" signing date as the start (prompt: "do not use it as the lease start …
    return null"; a gold ⚠ warned the user off typing it). Wingstop prints no commencement date —
    the signing date is the ONLY date on the page — so `lease_start` came back null and stayed empty.
    With no start, nothing downstream could be placed on a timeline: the 8-month abatement (start
    null) was **dropped on save** (`buildAbatements` needs a start+end), the 5 rent steps stayed
    undated, and the 3 renewal options had no term end to chain from. The extractor was actually
    reading the doc correctly — the app was throwing the one date away.
  - **Fix A — use the signing date as a suggested, editable start.** `LeaseNewPage.initialFromExtraction`
    now falls `lease_start` back to `execution_date` when no commencement is printed, and pre-fills the
    end from `start + term_months − 1 day`. `LeaseForm` swaps the scolding ⚠ ("that's the signing
    date, the term usually starts later — double-check") for a neutral, derived hint that shows on load
    ("Pre-filled from the signing date — change it if the term actually began later"). Extraction stays
    honest (`lease_start` still null); the UI makes the helpful, correctable suggestion. No prompt change.
  - **Fix B — a leading FREE period defers rent commencement.** New pure helper
    `leadingFreeMonths(leaseStart, abatements)` (`src/lib/abatement.js`): months of fully-free rent
    anchored at the start (reduced/percent periods and mid-term windows don't count). When it's > 0,
    the lease-year rent table is dated from **rent commencement = start + freeMonths**, not the lease
    start — so Wingstop's steps land Jan 2014/15/16/17 (12/24/36/48 mo after the 8 free months), inside
    the term, instead of May 2013…. Wired into `LeaseNewPage` (`createFromAi` + `SchedulePreview`) and
    `api.js anchorLeaseSchedule`. `createFromAi` also anchors the undated abatement's `start_date` to
    the confirmed `lease_start` so the free window is actually **saved** (was silently dropped). The
    review screen shows a "🎁 first N months free — paid rent starts {date}" note.
  - **Options need no date work:** each option is term-length and rolls forward from the term END when
    confirmed (round-2 chaining) — once the start (→ 2012) and end (→ Jan 2018) are right, Option 1 →
    2023, Option 2 → 2028, Option 3 → 2033 fall out automatically. That's the "increments of five."
  - Verified token-free: new `src/lib/__tests__/rentCommencementShift.test.js` (`leadingFreeMonths`
    reads 8; reduced/mid-term/empty → 0; steps date from start+8mo = Jan 2014…2017 with rents
    31450/32375/33300/34225; no-abatement regression dates from the start). Full suite **67/67 green**;
    `CI=true` build compiles. Committed only this task's files. Live check: re-upload Wingstop.pdf —
    start pre-fills to the signing date (adjust the day to the 4th), end auto-fills to ~Jan 2018, the
    8 months show free, steps date from Jan 2013, and the 3 options chain forward in 5-year increments.

- **2026-07-02** — Sync renewal options with the rent schedule + collapsible escalation list.
  Deployed: frontend Cloudflare version `1ac93011`; live-data repair of the Ricki's lease rows.
  No edge functions, no migrations, no new AI calls.
  - **The bug (Ricki's-Lyons):** the lease prints rents for ALL 20 years (5-yr initial term + three
    5-yr option periods), so on import the rent schedule correctly stepped through 2034 and the app
    is already charging year-12 (Second-Option-Period) rent — but the three renewal-option ROWS never
    learned their own windows. All three sat **Pending** with no rent + no notice date, and the First
    Option Period (2020–2025, clearly lived through) still showed Renew/Not-renewing buttons. Options
    had no concept of their time slot: `isLapsed` only compared the LEASE end (2031, future) so
    nothing lapsed, and `resolveCurrentTerm` ignores options by design (0034).
  - **Fix — `reconcileRenewalOptions(lease, today)`** (`src/lib/api.js`): derives each option's 5-yr
    window from `lease_start` + the initial `term_months` (read from the cached `extraction_raw`),
    chained in `cmpRenewal` order. Walks them: a window that has begun **and** has a matching dated
    rent step at its start is marked **applied** (the rent proves the tenant exercised it), its
    `new_rent` filled from that step, the committed term extended to cover it (via `max`, never
    shrinking a landlord-entered date), logged as a silent `renewal_confirmed` history event (no
    emails). The first still-future option stays **pending** but gets its `new_rent` (from the
    scheduled step) and its `notice_by_date` (from a "N days prior" notes clause → committed end − N
    days). **No rent evidence past the initial term → it stops (never guesses a renewal).**
    Evidence-gated + idempotent: only runs on a clean AI-imported lease whose options are ALL still
    pending — once any is applied/declined the manual confirm/decline flow (which moves `lease_start`)
    owns it and this bails, so window math can't drift. Wired into `backfillLeaseToToday`'s active
    branch (imports reconcile immediately) and the `promptDueRenewalDecisions` loop (app-load
    self-heal via `Layout.js`).
  - **Collapsible escalations** (`src/components/EscalationScheduleEditor.js`): a lease with >8 dated
    steps now collapses to the slice that matters — the 3 nearest upcoming + 3 most recent — with a
    "N earlier · M later steps hidden" line and a **Show all N steps / Show fewer** toggle (`useState`
    only, no data change).
  - Verified token-free: new `src/lib/__tests__/renewalScheduleSync.test.js` replays the exact live
    Ricki's shape (start 2015-05-01, term 60, steps through 2034, three "180 days prior" pending
    options) → Options 1-2 applied at $25,173 / $27,793.08, Option 3 pending at $30,685.80 + notice
    2030-11-02, header label "Second Option Period"; term-end preserved (2031) and the extend case;
    guards (manual lease w/ no cached file, no-evidence Vibhakar shape, idempotent re-run all no-op).
    Full suite **60/60 green**; `CI=true` build compiles. Committed only this task's files.
  - **Live data repaired** (lease `e9f51d85`): Options 1-2 → applied w/ the above rents, Option 3 →
    pending w/ rent + notice 2030-11-02, term left at George's 2031-05-01, two `renewal_confirmed`
    history events added — matching exactly what the deployed code computes (verified by re-query).
    Options are now non-all-pending, so the deployed reconcile skips this lease (guard) — no
    double-apply. No stale renewal bell prompt existed.

- **2026-07-02** — Wingstop follow-up: make an old lease's term structure ACTIONABLE (renewal
  options that reach past-term leases + a "Not listed → enter" rent affordance). Deployed:
  `extract-lease` edge function (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version
  `bd1f6e51`. No migrations.
  - **The problem (two screenshots):** the newest Wingstop extraction was actually CORRECT (verified
    in `lease_files` id `add46dfb` — null start/end, `term_months` 68, four relative rent steps, and
    **3 renewal options** with the 60-mo terms). What broke was everything downstream once the lease
    was saved with a **past** term: (1) the only date the doc prints is the **May-4-2012 signing
    date**, which got typed as the Lease start → end prefilled to ~Jan 2018 → whole term in the past;
    (2) a term entirely in the past made the 3 renewal options — the lease's own way to reach today —
    **hidden** as "lapsed" with no way to act on them; (3) options 2–3 state no rent ("greater of
    $41,403 or CPI" / "mutually agreed"), so they showed "—" and confirming would silently carry the
    old rent. So "5 years 8 months + three 5-year options" couldn't be turned into an actionable item.
  - **Fix A — lapsed options stay actionable & chain** (`RenewalOptionsEditor.js`): a pending option
    whose term window has passed is now shown (badged **"Lapsed"**), not hidden, and KEEPS its
    **Renew** / **Not renewing** buttons (Renew copy → "apply retroactively"; the ✉ heads-up email is
    hidden on lapsed rows). Applying one rolls the term forward from where it ended
    (`rollLeaseIntoRenewal`, unchanged) — chain Option 1 → Option 2 … until the lease is current;
    `backfillLeaseToToday` (already called by `confirmRenewal`) rolls the rent to today. A guidance
    note replaces the old "N lapsed not shown" line.
  - **Fix B — "Not listed → please enter" rent** (`RenewalOptionsEditor.js` + `api.js` + bell in
    `DashboardPage.js`): an option with no `new_rent`/`%` now reads **"Not listed — enter at renewal"**.
    Clicking Renew on it opens an inline row (shows the lease's own words from `notes`) to type the
    agreed **new base rent**; the bell "Yes" does the same via a new `confirmRenewalForLease(...,
    {needsRent})` handshake. `confirmRenewal(id, today, {newRent})` threads the override into
    `rollLeaseIntoRenewal` (precedence: entered → option `new_rent` → `%` → carry old) and records the
    entered figure back on the option row. Options that DO state a rent are unchanged (one-click).
  - **Fix C — banners point at the options** (`LeaseDetailPage.js`): the "outdated" + holdover banners
    now say "apply its N renewal option(s) below to bring it current" when pending options exist,
    instead of only mentioning addendums. `LeaseNewPage` `SchedulePreview` expired note gains the same
    nudge.
  - **Fix D — don't let the signing date pose as the start** (`extract-lease/index.ts` + `LeaseForm.js`):
    the supplement call now also reads `execution_date` (the signing / "entered into as of" date —
    NOT commencement; merged onto `parsed` like `term_months`, +1 union → 13/16, prompt-only, no new
    AI cost). If the user types that exact date as Lease start, a non-blocking **gold warn** appears
    under the field ("that's the signing date — the term usually starts later").
  - Verified token-free: new `src/lib/__tests__/renewalChainReplay.test.js` replays a past-term (2018)
    Wingstop-shaped lease with three 60-mo options — Option 1 (listed rent) applies → term 2023;
    Option 2 (unlisted) applies with an entered rent → term 2028, lease active again + rent recorded;
    `confirmRenewalForLease` returns `{needsRent}` and touches nothing on an unlisted option; a
    listed-rent option still one-clicks (regression). Full suite **63/63 green**; `CI=true` build
    compiles. Committed only this task's files. Live check: re-upload Wingstop.pdf (~2 small Haiku
    reads, ≈ a cent) — save with a past start → options listed as **Lapsed** with Renew, options 2–3
    read "Not listed", chaining Option 1 rolls the lease forward.

- **2026-07-02** — Fix big-scan lease extraction timeout (HTTP 546) + "no start date → ask the
  landlord, then date the whole schedule" flow. Deployed: `extract-lease` edge function (Supabase
  `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `db1bf70e`. No migrations.
  - **The real failure (Ricki's Cafe Lease.pdf):** George blamed the missing start date, but the
    Supabase edge log showed `POST | 546 /extract-lease` — the function was **killed at the ~150s
    wall-clock ceiling**, not a data error. Ricki's is a 12.9 MB, 36-page **scan** (no PDF text
    layer → vision path), and the function ran its **three** AI reads of the full doc
    **sequentially** — main fields → rent/contact supplement → `transcribeDocument` (16k-token
    transcription). The serial sum blew past 150s and the request died before returning (its
    `lease_files` row had `extraction_raw = null`). Wingstop (9.7 MB *digital* PDF) worked because
    the free text-layer path skips the vision reads. The generic "non-2xx" reached George because a
    runtime kill returns no `{error}` body for `invokeFunction` to read.
  - **Fix A — parallelize + time-box** (`extract-lease/index.ts`): the three reads are independent,
    so they now run under one `Promise.all` (wall time = slowest single call, **zero** new AI cost —
    same three calls). The transcription (vision-only, best-effort) is additionally capped at 90s via
    `Promise.race` (`transcribeWithTimeout`) so its long output can't dominate the budget on a huge
    scan; on timeout the lease still saves, only the cached Q&A text is missing (existing degrade
    path). `supabaseClient.js invokeFunction` now maps `status === 546` to a plain "took too long —
    try again / split the PDF" message as a safety net.
  - **Fix B — "no start date on file" is now a first-class flow** (the machinery from the Wingstop
    relative-schedule fix, but nothing asked for the date). A start-less lease keeps its **full read
    cached** on the linked `lease_files.extraction_raw` (undated steps aren't inserted — they can't
    be placed yet). New `anchorLeaseSchedule(leaseId, start)` (`api.js`) reads that cache and, once
    the landlord enters the real start: sets `lease_start`, fills `lease_termination_date` from
    `term_months` (start + term − 1 day), dates every rent step (`months_from_start` → real dates via
    existing `buildEscalations`) and abatements, then `backfillLeaseToToday` rolls the current rent
    forward. **Guarded** — only inserts rows the lease is missing, never duplicating or touching
    hand-entered steps. Surfaced two ways: a prominent ask above the review form
    (`LeaseNewPage.js`) and a **"📅 No start date on file"** banner + date input on the lease page
    (`LeaseDetailPage.js`); the "Lease start" field edit routes through the same helper so both paths
    behave identically. No migration — `extraction_raw`/`lease_file_id` already exist (0001).
  - Verified token-free: new `src/lib/__tests__/leaseStartAnchor.test.js` replays Ricki's shape
    (per-month lease-year rows, `term_months` 60) — relative rebuild → base $22,800 + undated steps;
    save with no start keeps the cache but inserts no steps; `anchorLeaseSchedule('2016-01-01')`
    dates the 4 steps (2017–2020-01-01), sets end 2020-12-31, rolls to today's rent; re-anchoring
    doesn't duplicate. Full suite **53/53 green**; `CI=true` build compiles. Committed only this
    task's files. Live check: re-upload Ricki's Cafe Lease.pdf (one Haiku vision read, ~cents) — it
    now completes; enter the start date to date the schedule.

- **2026-07-02** — Lease extractor: read undated "Year 1 / Year 2…" rent tables as RELATIVE, and
  suggest a term-based end date. Deployed: `extract-lease` edge function (Supabase
  `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `dedc9a4b`. No migrations.
  - **The bug (Wingstop.pdf):** the lease prints no start/end dates (commencement is a formula —
    "120 days after delivery" / "when the tenant opens") and its rent table is labeled by lease
    year ("Year 1 … Year 6"), not by date. The schema only accepted an absolute `effective_date`,
    so the model was **forced to invent dates** — it anchored the years to the May-2012 *signing*
    date and got them off by a year. The blank start/end were actually correct (verified in
    `lease_files.extraction_raw`); the invented escalation dates were the real problem. The lease
    was never saved, so no live data to repair.
  - **Fix — model reads relative, code does the date math** (same split as the rent-amount fix):
    `SUPPLEMENT_SCHEMA.rent_schedule` gains `months_from_start` (Year 1→0, Year 2→12, …) and the
    supplement returns `term_months` (e.g. "five years and eight months" → 68). Prompts updated so
    a lease-year table returns `effective_date: null` + an offset and NEVER anchors to the signing
    date; `SYSTEM_FIELDS` also hardened so the execution date isn't used as the lease start.
    `_shared/rentSchedule.js` `rebuildRentSchedule` grew a RELATIVE mode (no dated rows + offsets →
    base = smallest offset, later rows become undated steps carrying `months_from_start`); dated
    mode unchanged, so the addendum path is untouched.
  - **Frontend:** `buildEscalations(base, escs, anchorDate)` gains an optional anchor — a relative
    step gets its real date from `addMonths(start, months_from_start)` (reused `renewals.addMonths`)
    at save; with no anchor the step is dropped, never crashing the save. `LeaseNewPage` passes the
    confirmed `lease_start`; `SchedulePreview` lists undated steps as "After N months: $X" with a
    note instead of the false "no steps detected" warning. `LeaseForm` prefills Lease termination =
    start + `term_months` − 1 day (editable) once the user sets the start.
  - Layered cleanly on top of the same session's rent-abatement commit (`3f35c10`) — its
    `abatements` schema/prompt/preview additions preserved. Verified token-free: new
    `relativeRentSchedule.test.js` replays the real Wingstop table (base $30,525; steps land on
    2013-09-01…2017-09-01 off a Sep-1 start, no off-by-one; no-anchor → `[]`; end-of-month clamp;
    dated-mode regression). Full suite 49/49 green; `CI=true` build compiles. Committed only this
    task's files. Live check: re-upload Wingstop.pdf (~2 small Haiku reads).

- **2026-07-02** — Rent abatement (free / reduced rent periods) — brand-new feature, end to end.
  Deployed: DB migration `0041` + edge functions `extract-lease`, `extract-addendum`, `draft-invoice`
  (Supabase `awgrjmbcghdjgnqeiqkt`); frontend Cloudflare version `bb85704e`.
  - **Why:** a lease/addendum often grants free or reduced base rent for a stretch ("months 1-8 free").
    The app had **no concept of it anywhere** — the AI reader had no field, the DB couldn't store a $0
    period (rent rows are NOT NULL and the rent math discards $0), and nothing showed it, so a free
    period was silently dropped and the tenant still read as owing full rent. George asked for the full
    version: AI auto-reads it, supports fully-free OR reduced, and it flows all the way through billing
    and receivables. **Assumption (flagged):** abatement is BASE-RENT-only — CAM / taxes still accrue.
  - **Data model** (`0041_rent_abatement.sql`): new owner-scoped `rent_abatements` table (window +
    `kind` free/percent/amount + value + optional `addendum_id`); new SQL `abatement_credit(lease, year)`
    that walks the 12 months and credits the strongest window per month; `v_tenant_shares` recreated to
    append `abatement_amount`; `invoices.abatement_annual` column. All additive/idempotent.
  - **Shared math** (`src/lib/abatement.js`): the ONE source of truth (per-month schedule, annual credit,
    active-window, end-date-from-months) — mirrors `abatement_credit()` so JS + SQL agree to the cent
    (same pattern `leaseTerm.js` has with `effective_rent`).
  - **Reads it automatically:** `extract-lease` (supplement schema) + `extract-addendum` (rent schema)
    gained an `abatements[]` array + prompt lines — folded into the existing supplement/rent calls, so
    **no new AI calls** (negligible token bump only). `LeaseNewPage` maps them onto the review screen;
    `AddendumEditor` gained a "Grants free / reduced rent" effect card (pre-ticked when the AI finds one).
  - **Shows everywhere:** new `AbatementEditor` panel on the lease page (add/see/fix windows by hand);
    the "Currently in" header + AI-assistant context note when a window is active; the **Monthly Rent
    Tracker** + property rent roll now compute per-month owed (`getMonthlyRent`/`getPropertyMonthlyRoll`)
    so abated months show **"Free"** (or the reduced amount) and aren't billed.
  - **Billing & receivables:** `draft-invoice` returns `abatement_annual`; `InvoiceButton` +
    `invoiceTemplate` show a **"Rent abatement (credit)"** line and net the total; `ensureInvoice` /
    `markMonthPaid` net per-month owed → AR/receivables drop the free months automatically. `applyAddendum`
    inserts the windows + logs a `rent_abated` history event (`HistoryPage` labels it).
  - Verified: new `src/lib/__tests__/abatement.test.js` replays 8-month free (tracker 8 free + 4 full,
    year-1 net = 4 months, reconciles to gross − credit), 50%/fixed-$ reduced, and a window spanning two
    years; full suite **41/41 green**; `CI=true` build compiles; live DB confirmed `v_tenant_shares`
    exposes `abatement_amount` and `abatement_credit` runs. Committed only this task's files.

- **2026-07-02** — Fix lease-import date crash + review-box text wrapping. Deployed:
  `extract-lease` + `extract-addendum` edge functions (Supabase `awgrjmbcghdjgnqeiqkt`), frontend
  Cloudflare version `02970cf7`. No migration.
  - **Crash on save fixed** (`invalid input syntax for type date: "180 days prior to expiration of
    Original Term"`). A renewal's notice deadline was written in the lease relative to another event, so
    the model returned that prose in `notice_by_date` — which is a Postgres `date` column, so the whole
    lease save 400'd. New `isoDateOrNull()` in `api.js` accepts only a real `YYYY-MM-DD`; `buildRenewals`
    now nulls a prose deadline and preserves the wording in the option's `notes` ("Notice: 180 days prior
    …"), and `buildEscalations` drops any step without a real ISO date. Also hardened both extractor
    prompts (`extract-lease` + `extract-addendum`) so a relative deadline returns null + goes to notes,
    never prose in the date field. Prompt-only; no added AI cost.
  - **Review-box text no longer runs off the page.** The long warning/error messages in the "What gets
    saved — rent schedule" box (and the addendum review) used `.badge`, which is `white-space:nowrap` —
    designed for short pills, so full sentences overflowed. Added a wrapping `.note-msg` style
    (`App.css`) and switched the sentence-length warnings/errors in `LeaseNewPage.js` + `AddendumEditor.js`
    to it. Short status badges are unchanged.
  - Verified token-free: new `src/lib/__tests__/extractionDates.test.js` (isoDateOrNull + buildRenewals
    prose-deadline → notes + buildEscalations drops prose dates). Full suite 28/28 green; `CI=true` build
    compiles. Committed only this task's files.

- **2026-07-02** — History tenant attribution + lease extractor business-vs-people. Deployed:
  `extract-lease` edge function + DB migration `0040` (Supabase `awgrjmbcghdjgnqeiqkt`), frontend
  Cloudflare version `2871c109`.
  - **"Lease & tenant history" now shows WHICH tenant each event is about** (George couldn't tell them
    apart). Kept the feature, made it clear: migration `0040` adds a `tenant_name` column to
    `history_events`; `logHistoryEvent` records the tenant at write time and all five call sites pass it
    (extension/renewal events → the current tenant; an assignment → the new tenant). Old rows fall back to
    the lease's current tenant at read time (`listHistoryEvents`). `HistoryPage` timeline gains a
    **Tenant** column. Denormalized so attribution stays correct even after a later reassignment.
  - **Lease extractor differentiates business vs people.** `tenant_name` = the business/company entity
    (e.g. "D & D Dental, LLC" — full legal name incl. LLC/Inc./PC), `tenant_contact_name` = the person(s)
    who run it (signer/owner/guarantor, e.g. "Dr. Ahmed Hegazy"). Hardened `SYSTEM_FIELDS` (tenant_name is
    the entity, never a person) and `SUPPLEMENT_SYSTEM` (contact is a human, never the company, null if no
    person is named) in `extract-lease/index.ts` — prompt-only, no new AI calls / no added cost. Review
    form (`LeaseForm.js`) + lease page (`LeaseDetailPage.js`) now label the two fields with plain hints
    ("the business / company" vs "person(s) who run it") and business/person example placeholders.
  - Verified token-free: `addendumRenewalReplay.test.js` now also asserts each history event carries the
    right `tenant_name` (assignment → new tenant, extension → tenant at the time). Full suite 23/23 green;
    `CI=true` build compiles. Committed only this task's files.

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
