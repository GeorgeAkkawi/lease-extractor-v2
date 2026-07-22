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
> needs to be deployed live, append a dated entry below recording what went out
> (what changed, the files, and the Cloudflare version id). Keep newest at the top.

- **2026-07-21** — **AI file-size limit raised 20 MB → 25 MB, so a larger scanned lease / insurance / contract /
  bank statement can be read by the AI** (George: "increase lease download size for the ai to 25 megabites").
  Deployed: the 6 extract edge functions redeployed (Supabase `awgrjmbcghdjgnqeiqkt`) — `extract-lease`,
  `extract-insurance`, `extract-annual-report`, `extract-contract`, `extract-addendum`, `extract-bank-statement`.
  **Edge-function only — NO frontend build, NO DB migration, $0 (no per-request cost change; the existing paid
  AI lane just accepts bigger files), no tenant emails.**
  - **One shared constant:** `MAX_VISION_BYTES` in `supabase/functions/_shared/anthropic.ts` bumped
    `20 * 1024 * 1024` → `25 * 1024 * 1024` (25 MiB) — now matching the storage bucket (migration 0020) and the
    client upload guard (`api.js` `MAX_UPLOAD_BYTES`), which were **already** 25 MiB. A 20–25 MB file previously
    uploaded and stored fine but the AI reader rejected it as "about 20 MB max"; the six per-function guard
    messages were updated to "about 25 MB max" to match.
  - **Caveat (in the code comment + flagged to George):** the Anthropic request cap is ~32 MB and base64 inflates
    a file ~1.37×, so a source file near the very top of the range (~24 MB+) can still be rejected by the
    provider; nearly all scans sit well below it. CSV bank-statement imports are unaffected (they never touch the
    vision path).
  - **Files:** `supabase/functions/_shared/anthropic.ts` (the constant + comment) + the six `extract-*/index.ts`
    guard-message strings.
  - **Verified:** all 6 functions deployed clean; grep confirms the constant reads 25 MiB and zero "20 MB max"
    strings remain. No unit run needed (no `src/` logic changed).

- **2026-07-21** — **Per-tenant breakdown: a muted "Vacant space" line makes the unbilled slice of
  taxes+CAM visible, reconciling the tenant shares back to the Expense entry total** (George asked why the
  CAM & tax actuals didn't "sync" with the Expense entry; live-verified it was the 0042 building-SF design —
  Pershing FY2026: $146,200 entered × 12,868/13,750 leased = $136,821.93 across tenants, the $9,378.07 gap
  being the vacant 882 SF's share — and he confirmed "we could add the vacancy as a visual help for the user
  to see whats missing"). Deployed: frontend Cloudflare version `09f7e78c`. **Frontend-only — $0, no DB
  migration, no edge functions, no tenant emails; display-only, zero billing-math changes.** Tests **392/392**
  (was 391 — +1 vacancy-row render).
  - **`TenantShareTable.js`:** a muted italic **Vacant space** ledger entry above the Totals band — "{sf} ·
    {pct}% of the building — billed to no one" with the vacant slice of taxes+CAM
    (`(taxes_total+cam_total) × vacantSf / buildingSf`) and its $/SF (= every pro-rata tenant's rate); the
    Totals "CAM & tax · actual" gains the sub-line `+ $X vacant = $Y entered` (the "= entered" part only
    when the figures genuinely tie within 5¢ — a share override can bill off pro-rata); footnote updated to
    point at the row. Expense totals read via the SAME `['expenseRecord', propId, year]` query key the
    Financials page already uses → React Query dedupes, zero extra network. Hidden when no building size is
    set (fallback splits over leased SF — nothing missing, e.g. Harlem ties out exactly), fully leased, or
    no expenses entered — so the demo (fully leased) is unchanged and no demo redeploy was needed.
  - **Files:** `src/components/TenantShareTable.js`, `src/App.css` (`.ledger-vacant`),
    `src/components/__tests__/camReconciliation.test.js` (+1: shrink Bright Coffee 2,000→1,500 SF → 500 SF
    vacant row, $4,300.00 at $8.60/SF, totals sub "+ $4,300.00 vacant = $43,000.00 entered"; fully-leased →
    no row; seed restored).
  - **Verified:** unit **392/392** (`vitest run`); `vite build` compiles; live 200s (amlakre.com + www +
    workers.dev). Browser check skipped per George's standing preference (the jsdom test mounts the real
    table against the demo mock). **George: hard-refresh (Cmd+Shift+R) → Pershing's Financials now shows
    "Vacant space · 882 SF — billed to no one · $9,378.07" and the totals line reconciles to the $146,200
    entered.**

- **2026-07-21** — **Rent Ledger round 2: named expense BUCKETS (incl. a "not billed to tenants" kind),
  statement import from the Expense entry, a click-gated 🤖 bucket-suggest, estimates pulled from the
  lease, and the demo refreshed for George's walkthrough** (George after reviewing Stages 1–3: statements
  should be submittable "into the expense entry", AI sorts money in/out, "the user is able to create
  buckets — expenses or cleaning or garbage or snow or HVAC or electricity", "most of it is gonna go in
  the expense entry just so I have an itemized list of what I'm spending money on", "show me it in the
  demo mode"; plus "estimated CAM and tax should be pulled from leases but of course still be editable".
  His 2 AskUserQuestion picks: buckets = **both kinds** (billable CAM + one not-billed family) · AI =
  **click-gated suggest button**). Deployed: DB migration `0064` (pre-reviewed APPROVE), NEW
  `suggest-buckets` edge fn, frontend Cloudflare version `af27c300`, demo worker version `7233decc`.
  **$0 everywhere except the optional 🤖 click (~1–2¢) and the existing PDF lane (unchanged); 0064 is
  additive-only (one defaulted column + a widened CHECK); no tenant emails.** Tests **391/391** (was 383 —
  +6 expenseBuckets, +2 bucketUi).
  - **Buckets (migration `0064` + api.js + StatementReview + CamSection):** `cam_line_items.billable`
    (default true) — the CAM re-sum counts ONLY billable rows, so "Other — not billed to tenants" items
    are itemized for George's records but never touch `v_tenant_shares`/bills/reconciliation (stated in
    the UI; folding them into NOI = v2). The review's money-out dropdown is now **Property taxes · Roof ·
    optgroup "CAM buckets — billed to tenants" (the owner's saved labels + rules' labels + the keyword
    table's built-ins) · optgroup "Not billed to tenants" · ＋ New bucket… (inline name + billable tick) ·
    Ignore**; picks encode `cam:{label}`/`other:{label}` and save as labeled cam items with `billable`.
    "Always" rules now persist from the FINAL row decisions (a tick on an untouched suggestion saves too)
    and **carry `cam_label` + the new `expense_other` kind** (0064 widens the CHECK), so a bucket learned
    once auto-sorts forever. The Expense entry groups items by bucket with per-bucket subtotals
    ("Snow removal · 2 items · $4,600"), shows the not-billed group with its own total, adds an
    "imported" badge on statement rows, and the add form gains a bucket datalist + "not billed" tick.
  - **Import from the Expense entry:** the LedgerPage import machinery extracted into shared
    `ImportStatementButton.js` (+ `ImportResultsStrip` + the one shared `settleStatementImport`
    invalidation set) — the ⬆ Import statement / Try-a-sample buttons now ALSO sit on the Financials
    page's "Expense entry · FY" header, with the same full-page review swap + results strip + ↩ Undo.
    Two doors, one pipeline; the Ledger tab keeps its button.
  - **🤖 Suggest buckets (new `suggest-buckets` edge fn, Haiku, rate-limited 10/min, naming-ONLY):** shows
    on the review only when money-out lines are unrecognized; one click (~1–2¢) suggests a bucket +
    billable flag per line, STRONGLY preferring existing bucket names. Suggestion-only: picks land with an
    "AI" chip and stay UNCHECKED — unknown money-out still never books without George's tick. Verified
    live: unauthenticated POST → 401.
  - **Estimates pulled from the lease:** new `getLeaseStatedEstimate` reads the cached AI read
    (`lease_files.extraction_raw`'s 7/13 `expense_estimates` fields, fetched on-demand). The Financials
    estimate editor now OPENS PRE-FILLED with the lease-stated $/SF + a "from the lease: '…quote…' — Save
    to start billing it" line for a tenant with no estimate set; the lease page's Est-CAM/taxes hints say
    "the lease states $X/yr". Deliberate safety rule: nothing auto-applies — the figure only starts
    billing when saved (new uploads keep pre-filling on the review form as since 7/13).
  - **Demo (worker `amlak-demo` version `7233decc` — was on the pre-Ledger `d3d7123a`, so George couldn't
    see any of Stages 1–3 there):** canned statement enriched 6→9 lines (garbage→Waste removal,
    snow→Snow removal buckets + an unrecognized HOME DEPOT line that demos the 🤖 button via a canned
    `suggest-buckets` route); seeded a not-billed "Owner legal fees $1,200" bucket; City Dental's lease
    file seeded with a cached "$4.00/SF" estimate read so the editor demos the from-the-lease prefill.
    Bundle verified free of the live Supabase ref.
  - **Files:** `supabase/migrations/0064_expense_buckets.sql` (new), `supabase/functions/suggest-buckets/
    index.ts` (new), `src/lib/{api,statementMatch}.js`, `src/components/{StatementReview,CamSection,
    TenantShareTable,ImportStatementButton (new)}.js`, `src/pages/{PropertyFinancialsPage,LedgerPage,
    LeaseDetailPage}.js`, `src/lib/demo/{store,mockClient}.js`, tests (`expenseBuckets.test.js` +
    `bucketUi.test.js` new, `ledgerPage.test.js` extended).
  - **Verified:** unit **391/391** (`vitest run`); `vite build` compiles; live DB (read-only): `billable`
    default true + the widened `import_rules_target_kind_check` present; live 200s (amlakre.com + www +
    workers.dev). **Full 12-step real-browser drive-through of the deployed demo — 12/12 pass, ZERO
    console errors** (per-tenant est-vs-actual +$800 → estimate prefill "from the lease" → buckets in the
    Expense entry → sample statement → 🤖 on Home Depot → J-PAK assigned cross-property with an "always"
    rule → save books 2 payments/$14,625 + 5 expenses/$4,742.48 → CAM total $19,642.48 with imported
    badges + subtotals → City Dental March ◐→✓ → undo restores $18,000.00 exactly). **George: the
    walkthrough script for the demo is in the chat reply of this session.**

- **2026-07-21** — **Rent Ledger Stage 3 of 3: closing a year now freezes each tenant's COLLECTION picture,
  and History charts the collection trend year over year** (same approved plan; the partners' "resets yearly
  and saves history for trends" ask). Deployed: frontend Cloudflare version `f7fc6a15`. **Frontend +
  `src/lib` only — $0, NO DB migration** (the figures ride the existing `financial_snapshots.breakdown`
  jsonb), no edge-function redeploy (`trends-narrative` stringifies its whole series into the prompt, so the
  new keys flow in as-is), no tenant emails. Tests **383/383** (was 381 — +2 collectionSnapshot).
  - **`closeYear` (api.js)** now also builds the ledger roll and freezes per tenant: `projected` (the year's
    billed total), `collected`, `collection_rate` (raw/unclamped — an overpaid tenant truthfully reads
    >100%), and `collected_by_month` (the 12-array from the same allocatePayments derivation the grid
    paints from). Old snapshots simply lack the keys — every consumer renders "—", never NaN.
  - **Pure selectors in `ledger.js`:** `snapshotCollectionSummary(snap)` (property totals, null on a
    pre-ledger snapshot) + `collectionSeries(snaps)` (the YoY series, key-less years skipped, oldest first).
  - **History page:** a **Collected** DeltaCard joins the YoY strip (only when the snapshot has the data)
    and the YoY table gains **Collected** + **Rate** columns; the AI trends summary's series now carries
    `rent_collected`/`collection_rate` for years that have them. **Ledger tab:** a quiet "FY {N−1}
    collection rate: 96%" chip (from the closed year's snapshot) links to History. (The 12-month collected
    bar strip stays v2 — `collected_by_month` is stored from day one, so it's render-only later.)
  - **Demo:** snap-1/snap-2 breakdowns enriched with collection figures (snap-0 left key-less to demo the
    "—" fallback), so the demo History shows the trend and the demo Ledger shows the prior-year chip.
  - **Files:** `src/lib/{api,ledger,demo/store}.js`, `src/pages/{HistoryPage,LedgerPage}.js`,
    `src/lib/__tests__/collectionSnapshot.test.js` (new).
  - **Verified:** unit **383/383** (`vitest run`) incl. closeYear freezing the lump payer at rate 1.0 +
    penny-exact by-month sum, the null-summary/series-skip guarantees; `vite build` compiles. Browser check
    skipped per George's standing preference. Live 200s (amlakre.com + www + workers.dev). **All three Rent
    Ledger stages are now live** — George: Financials → **Ledger** tab per property (grid + import), the
    **Collected** column on the per-tenant breakdown, and collection trends on **History** once you close a
    year.

- **2026-07-21** — **Rent Ledger Stage 2 of 3: bank-statement import — drop a statement on the Ledger tab,
  the app recognizes every line in/out, and one Save books tenant payments + expenses with a full ↩ Undo**
  (same approved plan as Stage 1; the partners' headline ask — "drop a bank statement in; the app recognizes
  money in/out and classifies each payment", replacing their manual Excel deposits/rent-receipts tabs).
  Deployed: DB migration `0063` (Supabase `awgrjmbcghdjgnqeiqkt`, pre-reviewed APPROVE by the
  migration-reviewer agent), NEW `extract-bank-statement` edge fn, frontend Cloudflare version `6ad7832e`.
  **A CSV statement imports through pure client-side code — $0, NO AI; only a PDF statement uses one Haiku
  transcription read (~5–15¢, rate-limited 10/min). Classification/matching is ALWAYS deterministic code.
  No tenant emails; 0063 is additive-only (two new owner tables + nullable provenance columns).** Tests
  **381/381** (was 337 — +12 statementParse, +22 statementMatch, +9 statementImport apply/undo, +1 LedgerPage
  import round-trip render).
  - **Two lanes, one pipeline:** CSV read in the browser (`statementParse.js` — delimiter/header/junk-preamble
    detection, BOM, quoted commas, $-and-comma amounts, parentheses negatives, signed-amount OR Debit/Credit
    pairs) · PDF via the new transcribe-ONLY edge fn (verbatim lines, never computes/classifies). BOTH lanes
    pass the same `normalizeStatementRows` validation gate + the **running-balance self-check** (a mis-signed
    line flags "check" instead of silently booking; works newest-first or oldest-first) and the honest
    "N lines parsed · M skipped (with reasons)" header.
  - **Matching (`statementMatch.js`, pure, suggest-only):** each line's fiscal year comes from ITS OWN date
    (a Dec/Jan statement books each line into the right year; closed-FY lines get an amber chip but import
    normally — verified closeYear only snapshots). Duplicate guard = line-hash vs LIVE `payments.import_hash`
    (hand-deleted payments become importable again; "import anyway" override supported — NO unique index).
    **Rules = the payee memory**: tick "always" on a garbled payee once (pattern auto-derived as the longest
    digit-free run, so CHECK 1044/1045 both match) → every future import auto-books it; rules pin to lease_id
    and re-apply to the rest of the SAME file live. Deposits: tenant-name token fuzzy (LLC/INC noise dropped)
    across **ALL properties** (one bank account serves the portfolio — a Pershing check imported on Maple
    still posts to Pershing), corroborated by amount (billed month / gap / k-months / invoice total / an open
    **reconciliation true-up**, which books against THAT invoice with no month tag and never touches monthly
    coverage). Hand-entry collision guard un-checks a deposit whose months are already covered ("possibly
    already recorded by hand"). Withdrawals: keyword table (tax/roof/CAM-with-label; MORTGAGE/LOAN/TRANSFER/
    DRAW → ignore with the reason shown); **unknown money-out is never auto-booked**.
  - **Which statement is which property — 3 layers:** the review header states "**Expenses will be recorded
    on: {property}**" with a dropdown (deposits self-route regardless); a **majority vote** over matched
    deposits raises "N of M deposits match {other property} — record expenses there instead? [Switch]"; and
    the masked **account hint** (••4821, captured from the CSV preamble/filename) remembers each account's
    property ("Account ••4821 — last imported into …") and shows in the register.
  - **Review & save (`StatementReview.js`, full-page):** Money in · Money out · Duplicates (collapsed) ·
    Skipped (collapsed); per-row match dropdown (suggested + all tenants + expense kinds + ignore), month
    picker (— = lump → the Stage-1 FIFO pool absorbs it), confidence chip, "always" tick; **✓ Accept all
    confident**; footer confirm-summary BEFORE anything writes + warnings (reconciled tenants on the target
    FY / closed-year lines). `applyStatementImport` books deposits via ensureInvoice+recordPayment (identical
    row shape to hand entry — every downstream surface updates automatically), CAM → line items with an
    import badge **that keep their ✕**, taxes/roof → **accumulate** onto the FY record; every write recorded
    in `applied`. **Undo** (results strip + per-import in the register) reverses exactly the import's delta:
    payments delete-if-exists, CAM items removed + re-synced, taxes/roof decremented **clamped ≥0** (a manual
    edit up survives), hashes leave the dedupe universe — apply→undo→re-apply lands the same figures once
    (test-locked). History logs `statement_imported`/`statement_import_undone`.
  - **Demo:** "Try a sample statement" on the Ledger tab runs canned lines through the REAL gate + matcher +
    apply — the whole partner pitch with zero AI and zero files.
  - **Files:** `supabase/migrations/0063_statement_imports.sql` (new), `supabase/functions/
    extract-bank-statement/index.ts` (new), `src/lib/{statementParse (new),statementMatch (new),api,
    demo/store,demo/mockClient}.js`, `src/components/StatementReview.js` (new), `src/pages/{LedgerPage,
    HistoryPage}.js`, `src/App.css`, tests (`statementParse/statementMatch/statementImport.test.js` new,
    `ledgerPage.test.js` +1).
  - **Verified:** unit **381/381**; `vite build` compiles; live DB (read-only): both tables present with
    owner_all + require_aal2, `payments.import_id/import_hash` + `cam_line_items.import_id` present; edge fn
    deployed clean. Browser check skipped per George's standing preference — the jsdom round-trip test drives
    sample → review → save → strip → undo against the demo mock. Live 200s. **George: open a property's
    Financials → Ledger tab → ⬆ Import statement and drop your bank's CSV export** (free, instant); a PDF
    statement works too (~5–15¢).

- **2026-07-21** — **Rent Ledger Stage 1 of 3: a per-property projected-vs-actual collections grid (new
  Ledger tab), month-tagged payments, and a Collected/Owes column on Financials** (George approved the plan
  `~/.claude/plans/is-there-a-way-melodic-lemur.md` — built from his partners' voice-memo asks: live
  per-tenant "tenant owes $X / is owed $X", resets yearly, history for trends, Yardi as the model; his 4
  scoping picks: new tab + compact breakdown column · projected shows base and est CAM & tax separately ·
  import handles money in AND out (Stage 2) · manual entry stays). Deployed: frontend Cloudflare version
  `14749008`. **Frontend + `src/lib` only — $0, NO DB migration, no edge functions, no tenant emails**
  (`payments.period_month` from 0037 already existed). Tests **337/337** (was 280 — +17 ledger unit, +24
  resurrected arStatus, +4 midYearRent, +3 holdoverRoll, +5 money-collection marking, +4 LedgerPage render).
  - **Resurrected the 7/13-deleted schedule math as the foundation** (byte-identical from `cfe506f^`):
    `src/lib/leaseSchedule.js` (buildLeaseSchedule — now also returns `factor`, the invoice-scaling ratio —
    + owedByMonthForInvoice), `src/lib/arStatus.js`, and api.js's getMonthlyRent / getPropertyMonthlyRoll /
    markMonthPaid / unmarkMonthPaid / markMonthPaidAllTenants (both roll readers now also return each row's
    raw `payments` array).
  - **New pure `src/lib/ledger.js` — the ONE money derivation everything renders from.**
    `allocatePayments`: month-tagged payments cover their own month (same-month payments sum), untagged
    money pools and fills months 1→12 FIFO (a lump that runs out mid-June reads Jan–May ✓ · Jun ◐ · rest
    open), a tagged month's excess rolls forward as prepayment, leftover past December = credit (owed to the
    tenant, ≈ the invoice's negative balance). `componentizeSchedule`: base | CAM&tax | roof per month with
    the binding invariant components-sum-to-owed — a FREE month forces base $0 and CAM&tax absorbs the
    penny-fold cents (both folds can land on a free December, whose owed stays >0 because CAM/tax never
    abate). `ledgerRowSummary`: Collected / Owes-to-date / months-behind / credit — all from the SAME
    allocation, so the grid and the figures can never disagree (a test documents the tag-divergence case
    where arStatus's tag-blind FIFO names different months; arStatus stays as legacy fallback + a no-tags
    parity cross-check).
  - **New Ledger tab** (`src/pages/LedgerPage.js`, route `/financials/:corpId/:propId/ledger`; new
    `FinancialsTabs` seg strip Financials | Ledger on both pages): tenants × 12 months, ✓/◐/open/Free/—
    cells (tooltips carry each month's owed + base·CAM&tax·roof split), holdover badge, vacant-space row,
    per-tenant "$X/mo = $B base · $C CAM&tax" sub-line, Collected + Owes columns with an all-tenants totals
    row, ✓-all per month + "mark everyone paid through {month}" catch-up. Click semantics honor the
    allocation: an open month records in full, a pool-partial month records only its GAP (never
    double-collects), a pool-covered month isn't a toggle (manage the lump on the lease's payments panel),
    a tagged month click-undoes. `markMonthPaidAllTenants` rewritten gap-based for the same reason.
  - **Financials per-tenant breakdown** gains a 7th **Collected** column (linked to the Ledger; grid
    template switches via `.with-ledger` so the layout is byte-identical when the module's off) · **Invoices
    & payments** payment form gains an optional **"For month"** tag (annual invoices only; shown in the
    payments table) · new optional feature key `ledger` (Settings → Display picks it up automatically;
    ships ON — null = on) · demo seeds City Dental with Jan/Feb tagged checks + a $4,000 untagged partial
    so the demo grid shows every state at once.
  - **Files:** `src/lib/{leaseSchedule (new),arStatus (new),ledger (new),api,features,demo/store}.js`,
    `src/pages/{LedgerPage (new),PropertyFinancialsPage}.js`, `src/components/{FinancialsTabs (new),
    TenantShareTable,InvoicesPanel}.js`, `src/App.js`, `src/App.css`, tests (`ledger.test.js`,
    `ledgerPage.test.js` new; `arStatus`, `midYearRent`, `holdoverRoll` resurrected; `moneyCollection`
    re-expanded; `camReconciliation` wrapped in MemoryRouter for the new link).
  - **Verified:** unit **337/337** (`vitest run`) incl. the audit-derived cases (free-December fold-cents
    componentization, tag-on-free-month → pool, gap-based bulk settle to exactly $98,500, no-tags parity
    vs arStatus); `vite build` compiles. Browser check skipped per George's standing preference (jsdom
    render smokes mount the real LedgerPage + TenantShareTable against the demo mock). Live 200s
    (amlakre.com + www + workers.dev). **Stages 2 (bank-statement import, migration 0063 + edge fn) and 3
    (year-close collection history) follow in this same task.**

- **2026-07-21** — **Financials friction removed: quiet reconcile outcome + ↩ Undo on every action + the
  Invoice button dropped from the per-tenant rows** (George: "i just dont like … 'owed - xxx - invoiced' …
  i also need an undo button for each section on the financials page if i want to go back and change the fact
  that i clicked reconcile … i just want to eliminate user friction"; via AskUserQuestion he picked: Undo on
  EVERY action · outcome as quiet muted text · remove the ⚖ Reconcile confirm popup, adding "i also think
  that invoice is not necessary all we need is the reconcile button which is what really matters at the end
  of the year"). Deployed: frontend Cloudflare version `974e4bcc`. **Frontend + `src/lib` only — $0, NO DB
  migration** (history_events.type is free text; owner_all RLS covers the delete; the 0060 kind-scoped
  `where status<>'void'` unique index makes void-then-recreate legal), **zero demo-mock changes** (undo rides
  the mock's generic delete/update handlers), no edge functions, no tenant emails. Tests **280/280** (was
  275 — +3 undo unit, +1 undo-flow render, +1 CamSection-undo render).
  - **Quiet outcome (`TenantShareTable.js` + `.recon-note` in App.css):** the loud uppercase colored badge
    ("OWED $985.04 — INVOICED") is now one small muted lowercase line — `reconciled — owed $X · invoiced|
    overdue|partly paid|collected ✓`, `reconciled — you owe $X`, `reconciled — refunded $X ✓`, `reconciled —
    even` — with ✉ Statement / ✓ Mark refunded as small secondary buttons beside it.
  - **⚖ Reconcile is instant** — the `window.confirm` popup is gone; the persistent **↩ Undo** is the safety
    net (Gmail-style act-then-undo).
  - **↩ Undo everywhere.** (1) **Un-reconcile** (persistent, on every outcome state, any time later): new
    `undoReconciliation(recon)` in api.js — **voids** the linked reconciliation invoice FIRST (never deletes —
    payments stay attached, recoverable under the lease page's "removed"; void-first means an interrupted undo
    completes cleanly on a second click), hard-deletes the `cam_reconciliations` row (its unique index isn't
    status-scoped, so only deletion reopens the year), logs a `cam_reconcile_undone` history event. Undo's
    tooltip warns when money was already collected on the invoice. (2) **Transient strips** (new shared
    `UndoStrip.js`, the Dashboard undo-banner pattern shrunk inline — quiet "saved · ↩ Undo · ✕", component
    state, latest-wins, cleared on fiscal-year switch): estimate save (restores the exact prior `est_*`
    values), Mark refunded (new `undoReconciliationRefund` reverts to open + logs `cam_refund_reopened`),
    taxes/roof save (restores prior figures; a first-ever save undoes to zeros — the undo re-reads the record
    at undo time so a CAM total synced meanwhile is never clobbered), building size save, CAM line add (undo
    deletes it; `addCamLineItem` now returns the created row) and remove (undo re-adds label+amount), flat
    CAM save.
  - **Invoice button removed from the Financials rows** (UI-only): `InvoiceButton` un-wired from
    `TenantShareTable` — it was its ONLY usage, so annual-invoice generation has no UI now; the component/
    template/api plumbing stays dormant in the codebase (George reversed course on invoicing once before).
    Reconciliation invoices are still created by ⚖ Reconcile. `InvoicesPanel` empty-state copy updated to
    point at Reconcile instead of the removed Invoice modal.
  - **Files:** `src/lib/api.js` (undoReconciliation, undoReconciliationRefund, addCamLineItem returns the
    row), `src/components/{TenantShareTable,UndoStrip (new),BuildingSizeEditor,CamSection,InvoicesPanel}.js`,
    `src/pages/{PropertyFinancialsPage,HistoryPage}.js` (labels for the 2 new event types), `src/App.css`
    (`.recon-note`, `.undo-strip`), tests (`reconciliation.test.js`, `camReconciliation.test.js`,
    `camSectionUndo.test.js` new).
  - **Verified:** unit **280/280** (`vitest run`) incl. the full undo round-trips (un-reconcile → invoice
    void + record gone + re-reconcile clean; estimate save→undo restores the seed's split 6,500/10,000; CAM
    remove→undo re-adds + re-syncs the 18,000 total); `vite build` compiles. Browser check skipped per
    George's standing preference. Live 200s (amlakre.com + www + workers.dev).
  - **George — your Ricki's-Lyons row on fakkawi3:** it now reads the quiet `reconciled — owed $985.04 ·
    invoiced` line; if you never wanted that true-up, click **↩ Undo** on the row — one click removes it and
    voids the $985.04 invoice (hard-refresh first: Cmd/Ctrl+Shift+R).

- **2026-07-21** — **Demo sandbox refreshed to current `main`** (George: "open the demo … make sure the fields
  in financials are present so i can show how they work specifically the per tenant breakdown and expenses").
  The `amlak-demo` worker was running a pre-7/11 build (old "Leases" nav, Outstanding-AR card, un-merged
  CAM/tax columns). Rebuilt (`npx vite build --config vite.demo.config.js --outDir build-demo`) + redeployed
  (`npx wrangler deploy -c wrangler.demo.jsonc`) → demo Cloudflare version `d3d7123a`. **No code change, no
  commit needed, $0, no live-app touch** (bundle verified free of the live Supabase ref). Browser-verified on
  https://amlak-demo.akkawigeo-5.workers.dev — Maple Plaza Financials shows the current per-tenant breakdown
  (merged CAM & tax est/actual columns, +$800 Difference, estimate editor with the single CAM & tax $/SF/yr
  input, Invoice/⚖ Reconcile) and the full Expense entry section (building size, taxes & roof, itemized CAM);
  corp cards one-line Rev/Exp/NOI; zero console errors.

- **2026-07-21** — **Financials per-tenant breakdown: the Estimated column now reads "CAM & tax / estimated"
  to mirror the actual "CAM & tax / actual" column** (George: "Estimated on the financials page should follow
  the cam and tax format of the actual in the top column. it should say CAM and tax … make sure the base rent
  line item is also visually in line with those"). Deployed: frontend Cloudflare version `42e68154`.
  **Frontend-only — label/wording in `TenantShareTable.js`, zero logic/math changes; no DB migration, no edge
  function, $0, no tenant emails.** Tests **275/275**.
  - The two CAM & tax figures now read as an obvious pair: header col 3 = **"CAM & tax"** / sub-cap
    "estimated · billed to tenant", col 4 = **"CAM & tax"** / sub-cap "actual". The estimated figure already
    used the identical format as the actual (amount + $/SF sub-line); only the header/labels changed. Updated
    the screen-reader stat label ("CAM & tax · estimated · billed to tenant"), the Totals label ("CAM & tax ·
    estimated"), and the footnote wording ("The estimated CAM & tax is what the tenant actually pays…"). Base
    rent stays the leftmost numeric column in the same shared 5-column grid, so it lines up with both CAM & tax
    columns unchanged.
  - **Files:** `src/components/TenantShareTable.js` only.
  - **Verified:** unit **275/275** (`vitest run`) incl. the camReconciliation + reconciliation suites (no test
    asserted the old "Estimated" header, and the duplicated "CAM & tax" header text doesn't collide with any
    getByText); `vite build` compiles. Browser check skipped per George's standing preference. Live 200s.

- **2026-07-21** — **Financials corporation cards: Revenue / Expenses / NOI now always on ONE line, so every
  card is formatted identically** (George: "nasa vs gena property on financials page looks different in terms
  of formatting the cards. rev expenses and noi should be one line"). Deployed: frontend Cloudflare version
  `6aca3315`. **Frontend-only — CSS in `src/App.css`, zero logic/math changes; no DB migration, no edge
  function, $0, no tenant emails.** Tests **275/275** (unchanged — CSS-only).
  - **Root cause:** the three fin figures (`.corp-fin`) were a **wrapping flex row** with
    `justify-content:space-between`, so their line layout depended on each figure's width. Beta account
    fakkawi3's GENA card (Revenue $203,759.52 · Expenses **$0.00** · NOI $203,759.52 — one short "$0.00") and
    NASA card (three wide 6-figure values: $302,537.36 / $146,200.00 / $156,337.36) wrapped **differently** in
    the same-width grid cell — one showed the trio on a single line, the other broke it across two. That's the
    "looks different" George saw.
  - **Fix:** `.corp-fin` is now a fixed **3-column grid** (`repeat(3,minmax(0,1fr))`), so Revenue/Expenses/NOI
    always occupy exactly one row of three equal columns — identical on every card regardless of figure width.
    Dropped `flex-wrap`/`justify-content:space-between`. To guarantee even NASA's three 6-figure values fit one
    line at the grid's narrowest 320px cell, the figure font now **scales with card width** via a container
    query: `.corp-card.fin{container-type:inline-size}` + `.corp-fin b{font-size:clamp(13px,4.5cqw,20px)}`
    (full 20px on wide cards, shrinking only when a cell gets tight), plus `white-space:nowrap` and `min-width:0`
    on the cells so a figure never wraps or overlaps its neighbor.
  - **Files:** `src/App.css` only (the `.corp-card.fin`, `.corp-fin`, `.corp-fin>div`, `.corp-fin b` rules).
  - **Verified:** unit **275/275** (`vitest run`); `vite build` compiles. Per George's standing preference the
    real-browser check was skipped (CSS-only tweak). Live sites 200 (amlakre.com + www + workers.dev).

- **2026-07-20** — **Financials per-tenant breakdown: CAM & tax merged into ONE combined figure** (George:
  "estimated cam and tax for the leases on the financials page should be one number" → via AskUserQuestion he
  scoped it: "merge the estimate entry into one cam and tax number PSF that the user inputs — i also want the
  actuals columns which pulls from the expense entries (the actual) to be merged into one CAM and tax line as
  well"). Deployed: frontend Cloudflare version `41667b7f`. **Frontend + `src/lib` only — $0, no DB migration,
  no edge-function redeploy, no tenant emails, no destructive data.** Tests **275/275** (was 274 — +1
  combined-estimate `billedComponents` case).
  - **What changed on the Finances → Per-tenant breakdown (`TenantShareTable`):** the two separate **actual**
    columns "Property taxes" + "CAM" are now ONE **"CAM & tax"** actual column (= `cam_amount + tax_amount`,
    with a combined $/SF sub-line); the inline **estimate editor** is now ONE **"CAM & tax $/SF/yr"** input
    (was separate CAM and Tax fields); the Totals row merges the two actual totals; the Estimated column was
    already combined (unchanged). **Roof stays its own separate line throughout.** Reconciliation follows
    automatically — CAM & tax true up as a single line (Difference is unchanged, still actual − estimate incl.
    roof in the total).
  - **Storage (no migration):** the merged editor saves the whole combined figure into `est_cam_annual` with
    `est_tax_annual = 0`, so `cam + tax` always reads back as the single number entered. Older leases that had
    CAM and tax typed separately still sum correctly (the editor prefills from their sum). New pure
    `billedComponents().camTax` (= `cam + tax`) is the one combined figure the display/editor use.
  - **Reconciliation + statement:** `reconcileFigures` now emits one `camtax` line (label "CAM & tax") + roof;
    `draftCamReconciliationEmail` (api.js) builds one combined "CAM & tax" statement line (sums the stored
    est/actual cam+tax); the letter's charge-names phrasing renders "CAM and tax" cleanly.
  - **Tenant invoice (necessary consequence):** `invoiceTemplate.js` bills CAM + property tax as ONE
    **"CAM & property tax (YYYY est.)"** line (= `cam_annual + tax_annual`) instead of two lines — the total is
    unchanged, and this avoids a mislabeled/`$0` tax line once the estimate is stored combined. `draft-invoice`
    edge fn NOT touched (it already returns `cam_annual`/`tax_annual`; the template sums them) — so **no
    Supabase redeploy**. NOTE for George: this drops the separate "Property tax (prior-year est.)" line on the
    invoice — say the word if you'd rather invoices keep CAM and tax itemized while the Finances page shows them
    merged.
  - **Files:** `src/lib/reconciliation.js`, `src/components/TenantShareTable.js`, `src/lib/api.js`,
    `src/lib/emailTemplates.js`, `src/lib/invoiceTemplate.js`, `src/App.css` (ledger grid 6→5 numeric columns),
    `src/lib/__tests__/reconciliation.test.js`, `src/components/__tests__/camReconciliation.test.js`. Demo mock
    needed no change (its draft-invoice path already returns cam/tax the template sums; the seed's split
    estimates display merged).
  - **Verified:** unit **275/275** (`vitest run`); `vite build` compiles (788 modules). Per George, the
    real-browser drive-through was skipped this round. Live sites 200 (amlakre.com + www + workers.dev).
    Committed only this task's files.

- **2026-07-13** — **Removed the monthly rent tracker, receivables, and monthly rent roll** (George: "i want
  to remove the following from this platform: monthly rent tracker, receivables, and monthly rent role"). He
  chose the **"Keep invoicing"** scope via an AskUserQuestion — remove the money-*tracking* UI + its dead
  plumbing, but KEEP the **Invoices & payments** panel and the Invoice / Statement / year-end CAM-reconciliation
  tools. Deployed: frontend Cloudflare version `6490e831`, `send-reminders` edge fn redeployed (Supabase
  `awgrjmbcghdjgnqeiqkt`). **Frontend + one edge-fn redeploy — $0, no DB migration (invoices/payments/
  cam_reconciliations tables kept, non-destructive), no AI, no tenant emails, no destructive data.** Tests
  **274/274** (was 317 — −43 from the removed monthly-tracker/roll/AR test files).
  - **What was removed:** the **monthly rent tracker** (the 12 month-boxes on each lease page), the **monthly
    rent roll** (the per-month "mark all tenants paid" grid on each property's Financials page), and
    **receivables tracking** — the Overview **"Outstanding (AR)"** card, the Financials **"Receivables ·
    outstanding"** section, the **"Behind on rent"** dashboard alerts, and the **overdue-rent reminder emails**.
  - **What stayed (the "Keep invoicing" scope):** the **Invoices & payments** panel on each lease + its
    `lease_receivables` Display toggle; **Invoice / Statement / ⚖ Reconcile** generation (`TenantShareTable`,
    `InvoiceButton`, all CAM-reconciliation code); the Overview **"Annual rent roll"** card + **"⬇ Download rent
    roll (Excel)"** export; and the invoices/payments/`cam_reconciliations` DB tables + `draft-invoice` edge fn.
  - **Code:** deleted `MonthlyRentTracker.js` + `PropertyRentRoll.js` (components) and `arStatus.js` +
    `leaseSchedule.js` (fully-dead libs). `LeaseDetailPage.js` dropped the Monthly-rent panel + the fiscal-year
    selector (Invoices & payments doesn't follow it). `PropertyFinancialsPage.js` dropped the `ARSummary` section
    + the monthly roll (per-tenant breakdown + expense entry untouched). `DashboardPage.js` dropped the
    Outstanding-AR card + its `portfolioAR` query + the dead `focus==='invoice'` email branch.
    `api.js` removed getMonthlyRent/markMonthPaid/unmarkMonthPaid/getPropertyMonthlyRoll/markMonthPaidAllTenants/
    occInfoForInvoices/getPropertyAR/getPortfolioAR/summarizeAR + their imports, the behind-on-rent invoice fetch
    from `fetchAlertData`, and the invoice branch in `draftAlertEmail`. `alerts.js` removed the behind-on-rent +
    overdue-reconciliation block; **the free-rent-ending alert stays and is no longer gated by the receivables
    display pref** (it's a lease/abatement signal). `dashboardWidgets.js` dropped the `ar` /
    `lease_monthly_rent` / `property_rent_roll` toggles (kept `rent_roll` + `lease_receivables`). `prefetch.js`
    dropped the portfolioAR prefetch. `emailTemplates.js` dropped `buildPaymentReminderEmail`. Dead query-key
    invalidations (`propertyAR`/`portfolioAR`/`monthlyRent`/`propertyRentRoll`) cleaned out of the KEPT
    components (`TenantShareTable`, `InvoicesPanel`, `InvoiceButton`, `AbatementEditor`, `BuildingSizeEditor`).
  - **Edge fn (`send-reminders`):** removed the overdue-reconciliation email sweep + its `overdueBucket`/
    `widgetOn` helpers and the `overdue` field from the JSON result (insurance/contract/annual-report sweeps
    untouched). Redeployed clean.
  - **Tests:** deleted `arStatus.test.js`, `midYearRent.test.js`, `holdoverRoll.test.js`,
    `rentRollHoldover.test.js`; pruned `moneyCollection.test.js` (kept penny-true schedule + invoice-dedupe +
    invoice-template; dropped monthly/mark-all/summarizeAR/payment-reminder), `reconciliation.test.js` (dropped
    the getMonthlyRent ÷12 case, kept the year-vs-recon distinction via getYearInvoice + all CAM cases),
    `notificationGating.test.js` + `sixMonthAlerts.test.js` (dropped the behind-on-rent + `ar`-gate assertions;
    added a "free-rent not gated by receivables prefs" case).
  - **Verified:** unit **274/274** (`vitest run`); `vite build` compiles (788 modules). **Real-browser check**
    (system playwright vs the demo dev server, run inline): Overview has **no** Outstanding-AR card (3 cards:
    Annual rent roll · Occupancy · Expiring; Download-rent-roll button present); property Financials has **no**
    Receivables section and **no** monthly roll (Per-tenant breakdown + Expense entry present); the lease page
    has **no** Monthly-rent panel and **no** FY selector (Invoices & payments present); Settings → Display no
    longer lists the three removed toggles (Invoices & payments + Annual rent roll toggles remain) — **zero
    console errors** (a one-off dev-server 500 on SecuritySettings.js was a warm-up transform hiccup; the
    production build transformed all 788 modules clean and a reload rendered it fine). Live sites 200
    (amlakre.com + www + workers.dev). Committed only this task's files.

- **2026-07-13** — **Bugfix: the auto sign-out feature was locking returning users out the instant they
  signed in** (George: "i cant sign into my fakkawi email account"). Deployed: frontend Cloudflare version
  `27b462c9`. **Frontend-only — $0, no DB migration, no edge function, no tenant emails, no destructive data.**
  Tests **317/317** (was 312 — +5 `initialActivityStamp`).
  - **Diagnosis (read-only live DB, `supabase db query --linked`):** the beta account `fakkawi3@gmail.com`
    (`2efba6de-…`) was healthy — email confirmed, **not banned, NO 2FA factor enrolled** — and its
    `last_sign_in_at` had just updated to today (so the **password worked**), yet `auth.sessions` held **no
    live session**. Classic "auth succeeds but the session never sticks" → a client-side sign-out firing
    immediately after login.
  - **Root cause — the auto sign-out (0062) inherited a stale activity stamp.** `AutoLogout.js` tracks
    idleness via `localStorage['amlak:lastActivity']`, which **survives sign-out**. A returning user whose
    previous stamp is older than their idle window (default 30 min) hit this: the seed line only wrote a fresh
    stamp when the key was **absent** (`if (!localStorage.getItem(ACTIVITY_KEY)) …`), so a *stale* leftover key
    was kept, and the very first idle poll (runs on mount) read it as long-expired → `doSignOut()` instantly.
    Signing in / loading the page is itself activity, so the stamp should have been reset, not inherited.
  - **Fix.** New pure **`initialActivityStamp(storedMs, nowMs, minutes)`** in `idleLogout.js` — **keep** a
    RECENT stored stamp (so genuine cross-tab activity still counts) but fall back to **now** when it's
    missing, unparseable, in the future, or already past the idle window. `AutoLogout.js` reconciles the stamp
    through it on (re)start (replacing the absent-only seed), and the effect now depends on `minutes` too, so a
    preference that loads AFTER mount (e.g. a tighter 15-min window than the 30-min default) re-reconciles
    before the poll can act on the old value. Net: a sign-in / reload always starts the idle clock fresh;
    walk-away-and-leave-it-open still signs out as designed.
  - **Files:** `src/lib/idleLogout.js`, `src/components/AutoLogout.js`, `src/lib/__tests__/idleLogout.test.js`
    (+5: the stale-stamp lockout → reset; recent kept; missing/invalid/future → now; the tighter-window
    pref-loads-late edge; null-default vs off).
  - **Verified:** unit **317/317** (`vitest run`); `vite build` compiles; live sites 200 (amlakre.com + www +
    workers.dev). **George: try signing in again** (a hard refresh — Cmd+Shift+R — helps the new bundle load).
    If it still bounces, open a private/incognito window once (no leftover stamp) to get in immediately; the
    fix means it won't recur.

- **2026-07-13** — **Receivables panel on the Finances page: name WHO's behind (+ link to each lease), define
  "Outstanding", and judge "behind" against each tenant's real rent schedule** (George's three asks: the
  "behind on rent / 1 month behind" boxes "dont make sense if i dont know which tenants its applied to"; "what
  number is the outstanding balance refering to where it says 10 invoices still owed"; and "some leases start
  mid year … that logic must be affecting something — evaluate". He approved the plan
  `~/.claude/plans/the-receivables-on-the-fluffy-pillow.md`; his three scoping picks were the recommended ones:
  keep all-years totals with per-row FY tags · named tenant list replaces the count boxes · fix the math
  everywhere). Deployed: frontend Cloudflare version `6648163b`. **Frontend + `src/lib` only — $0 (no AI), no
  DB migration, no edge function, no tenant emails, no destructive data.** Tests **312/312** (was 306 — +5
  arStatus schedule-aware cases, +1 summarizeAR detail).
  - **What George saw + the evaluation (all confirmed in code).** (1) The AR boxes were pure aggregates with
    nothing to click; `byMonthsBehind.m1/m2plus` even counted *invoices*, not tenants (a tenant with an unpaid
    annual AND an overdue reconciliation counted once in "N tenants" but twice across the boxes), and an
    overdue reconciliation was mislabeled "2+ months behind". (2) "Outstanding · N invoices still owed" = Σ
    unpaid balances across **every** saved invoice for the property — **all fiscal years, annual +
    reconciliation** — while the query key `['propertyAR', propId]` carried no year, so it silently ignored the
    FY selector the rest of the page follows. (3) Mid-year lease STARTS were already handled right
    (`occupancyStart` → `inTermMonths`/`monthsDueByNow`; invoices prorated since 0061; holdover months keep
    owing) — BUT a real blind spot: `monthsBehindForInvoice` assumed LEVEL rent (total ÷ in-term months) while
    the rent roll **on the same page** is schedule-aware. Worked example: $1,000/mo gross, Jan–Mar free, net
    invoice $9,000 → the cards' flat $750/mo made a tenant who'd properly paid April's $1,000 read "$2,000 / 3
    months behind" while the roll showed every due month settled. The dashboard bell shared the blind spot.
  - **Fix — one schedule-aware definition, used everywhere.** New pure **`src/lib/leaseSchedule.js`**:
    `buildLeaseSchedule` moved out of `api.js` unchanged (3 call sites updated), plus new
    **`owedByMonthForInvoice(invoice, {leaseStart, escalations, abatements})`** → a length-12 owed-per-month
    array built from the invoice's own gross figures (base/cam/tax/roof_annual) + the escalation ledger +
    abatement windows, **scaled to the invoice total** so free months are $0, pre-tenancy months are $0, and a
    mid-year rate step bills the old rate before it. Returns null when an invoice has no gross breakdown → the
    caller falls back to the even-split (never reads an all-$0 schedule as "never behind").
    `arStatus.monthsBehindForInvoice` gained an optional `ctx.owedByMonth` path (walks the DUE months —
    earliest-first — counting the ones a payment doesn't cover; **byte-identical even-split fallback** when
    absent). `summarizeAR` now precomputes the schedule for the **current fiscal year's annual invoices only**
    (a past year has all months due → the even-split is already exact) and returns a new **`detail`** list —
    one row per owing invoice `{invoice_id, lease_id, tenant_name, year, kind, balance, behind, isReconciliation,
    monthsBehind, amountBehind, due_date}`, sorted most-behind first — while every existing aggregate field
    (`outstanding, count, tenantsBehind, amountBehind, byMonthsBehind`) is unchanged, so the Dashboard AR foot
    keeps working untouched. `occInfoForInvoices` enriched (leases select adds `tenant_name, base_rent`; batches
    abatements). **The same fix reaches the dashboard bell** — `alerts.js`'s behind-on-rent block builds the
    identical owed-per-month for current-year annual invoices (fetchAlertData's invoice select widened to carry
    the gross components; leases select gained `base_rent`).
  - **UI (`PropertyFinancialsPage.js` + `.ar-*` in `App.css`).** The two count boxes are **replaced by a named
    list**: each behind tenant by name, tags reading "N months behind · $X" / "Reconciliation overdue · $X"
    with an **FY** chip, every row a link to `/leases/{corp}/{prop}/{lease}`. Two cards stay — **Outstanding**
    (foot now reads "N invoices · all years", finally answering George's question) and **Behind on rent** (foot
    "N tenants"). A quiet **"Show the N outstanding invoices"** toggle expands a full breakdown (tenant · FY ·
    Reconciliation badge · balance · link); an **"All tenants are current"** empty state when nothing's owed.
    Rewritten explainer states the total spans all years and that free / pre-lease months don't count as behind.
  - **Files:** `src/lib/leaseSchedule.js` (new), `src/lib/arStatus.js`, `src/lib/api.js`, `src/lib/alerts.js`,
    `src/pages/PropertyFinancialsPage.js`, `src/App.css`, `src/lib/__tests__/arStatus.test.js`,
    `src/lib/__tests__/moneyCollection.test.js`. (Demo mock needed no change — its generic query builder already
    serves the widened selects; `v_invoice_balances` mock carries the gross components + kind defaults to
    'annual'.)
  - **Verified:** unit **312/312** (`vitest run`) incl. the Jan–Mar-free worked example (schedule-aware = NOT
    behind where the old even-split said 3 months), a genuinely-behind-with-abatement case, a mid-year step
    where the amount-behind uses the NEW rate (not total/12), malformed-owedByMonth fallback parity, and the
    `detail`-list naming/sort/kind assertions. `vite build` compiles (792 modules). **Real-browser check**
    (system playwright vs the demo dev server): Maple Plaza shows **City Dental · "7 months behind ·
    $57,458.31" · FY 2026** linking to its lease, Outstanding **$98,500 · 1 invoice · all years**, the breakdown
    expands to the single invoice, the row click lands on the lease page, and Oak Center (no invoices) shows the
    "All tenants are current" empty state — the behind figure ties to the schedule-scaled roll — **zero console
    errors**. Live sites 200 (amlakre.com + www + workers.dev). Committed only this task's files.

- **2026-07-13** — **Corporation cards fit + page heading matches the tab on Financials & History** (George:
  "fix corporations tab formatting on the financials page as well as the history page" — he confirmed the two
  symptoms: the corp NAME was cut off / cards cramped, and the page TITLE said "Corporations"). Deployed:
  frontend Cloudflare version `071fbc53`. **Frontend-only — layout/CSS + one heading line + a test; zero
  logic/math changes, no DB migration, no edge function, $0, no tenant emails.** Tests **306/306** (was 303 —
  +3 heading).
  - **Two symptoms, one shared component.** The Financials + History corp grids are the SAME
    `CorporationsPage.js` rendered with `mode="financials"`/`"history"`. (1) Each fin card's header
    (`.corp-head`) packed the badge + corp name + **two action pills** ("Business profile" + "Annual report")
    onto one non-wrapping row; in the narrow grid cells the pills won the space and the name hard-truncated to
    an ellipsis (`.corp-info strong` had `white-space:nowrap;text-overflow:ellipsis`, and the fin card
    overrode the name column to `min-width:0`). (2) The `<h1>` was hard-coded to "Corporations" for all three
    modes, so Financials/History both read "Corporations".
  - **Fix.** (1) `CorporationsPage.js` — `<h1>{TITLES[mode]}</h1>` (the per-mode map already existed:
    Financials→"Financials", History→"History"; **intended side effect** — the Portfolio/leases tab heading
    now reads "Portfolio", finally matching its sidebar label). (2) `App.css`, **scoped to `.corp-head` which
    is used ONLY by the fin cards** (grepped — `.corp-row` is unused dead CSS, Portfolio cards untouched):
    `.corp-head` gains `flex-wrap:wrap` (pills drop to their own row when the cell is narrow),
    `.corp-head .corp-info` `min-width:0`→`150px` (reserves a readable name column so wrapping triggers before
    the name is crushed), + a new `.corp-head .corp-info strong{white-space:normal;overflow:visible}` (the
    name wraps instead of ellipsis-ing on these cards; the base ellipsis rule still governs the Portfolio
    cards). On a wide card everything stays on one line (unchanged look).
  - **Files:** `src/pages/CorporationsPage.js`, `src/App.css`, `src/pages/__tests__/corporationsHeading.test.js`
    (new — asserts the h1 per mode).
  - **Verified:** unit **306/306** (`vitest run`); `vite build` compiles. **Real-browser check** (system
    Chrome headless via playwright-core against the demo dev server — the shared MCP browser was held by a
    concurrent session): at **1280px AND 360px**, both tabs — heading reads "Financials"/"History", every fin
    card's corp name renders untruncated (`whiteSpace:normal`, `.corp-head` `flex-wrap:wrap`), both pills
    present, and Portfolio reads "Portfolio" — **zero console errors**. Live sites 200 (amlakre.com + www +
    workers.dev). Committed only this task's files.

- **2026-07-13** — **Ask Amlak: Clear-answers button + a LOT more facts in the summary (roof, lease terms,
  billed CAM/tax, next rent step, free rent, additional-insured, occupancy, annual-report dates) + a
  "📄 read my leases" fallback when the facts fall short + a configurable auto sign-out** (George approved
  the plan — `~/.claude/plans/need-a-way-to-cheerful-narwhal.md`; his picks: expand the facts AND add a
  quick-model docs fallback, keep the visible-list Clear, idle timeout chosen in Settings, 60-second stay-
  signed-in warning). Deployed: DB migration `0062` (Supabase `awgrjmbcghdjgnqeiqkt`), NEW `ask-leases`
  edge fn + `ask-portfolio` redeployed, frontend Cloudflare version `9658c863`. **The only spend is the
  explicit-click docs fallback (~5–10¢/question, repeats $0 via cache); expanding the facts is $0 per
  question; the migration is one additive nullable column; no tenant emails, no destructive data.** Tests
  **303/303** (was 288 — +6 idleLogout, +9 portfolio: enriched facts + v4 fingerprint + holdover-inclusion).
  - **Why George asked:** Ask Amlak answered "which tenants pay for roof?" with *"the summary does not track
    roof responsibility."* Root cause: it reads a compact **facts-only records summary** (never lease
    documents), and roof wasn't one of the facts. He wanted BOTH — pack far more facts in, then a fallback
    that reads the actual leases with a quick model. Plus a Clear button and an auto-logout.
  - **1) Clear answers (`AskPage.js`):** the Q&A log is component state (memory only — zero storage; the
    saved-answer cache is one tiny per-user row per question with stale rows auto-deleted, so no scaling
    concern), so a quiet "Clear answers" ghost button just wipes the visible list.
  - **2) Richer facts (`portfolio.js` + `fetchPortfolioSnapshot` in `api.js`):** per tenant now — **roof
    share billed yes/no** (`leases.roof_responsible`, the reported gap), lease-terms note, contact/email/
    suite, **this year's billed CAM+tax(+roof) share and total** (from `v_tenant_shares`), **next scheduled
    rent step** (gated to within the committed term), **active/upcoming free-rent window** (`rent_abatements`),
    **additional-insured** (gated under the Insurance feature). Per property — **occupancy / vacant SF /
    annual revenue** (`v_property_totals`). New **CORPORATIONS** section — each corp's annual-report due/last-
    filed (`annual_reports`, core/never gated). **Holdover (is_active=false) tenants are now INCLUDED and
    flagged "held over"** (were dropped entirely) — matches George's rule that outdated tenants count until
    removed. Feature gating unchanged in shape (insurance/contract facts vanish when the module's off).
    Fetch adds the extra lease/insurance columns + 4 bulk queries (escalations, abatements, annual_reports,
    the two views by property_id + current year).
  - **Cache-staleness fix — fingerprint `v3→v4`:** bumping the version kills every thinner-summary cached
    answer instantly (so the wrong "doesn't track roof" answer dies), and new components (escalations /
    abatements / annual_reports count+max-stamp, plus a **value-based shares sum** so an expense edit that
    re-splits CAM/tax flips the cache with no updated_at to key on) keep future edits invalidating correctly.
  - **3) "📄 Read my leases" fallback:** new `ask-leases` edge fn (Haiku 4.5, user-scoped RLS client from the
    caller's JWT — reads ALL the caller's `lease_text` + `lease_addendums` server-side, corpus in a
    `cache_control` block, per-doc 30k / total 250k caps with an honest truncation note, grouped-by-tenant +
    quote-the-clause). `ask-portfolio` now ends a can't-answer reply with a `[NEEDS_DOCS]` token which the fn
    strips and returns `{answer, needs_docs}`; `askLeasesDocs()` (client) is cache-first under a `docs::`
    key + a light corpus fingerprint (leases+riders count/updated_at) so repeats are $0. AskPage shows a
    prominent **"📄 Read my leases to answer this (~a few cents)"** when `needsDocs`, and a quiet ghost
    "Answer from the lease documents instead" on every answer (for when the fact answer is wrong, not just
    missing); the docs answer appends under the same entry with the saved-answer tag on cache hits. Only ever
    runs on an explicit click (George's cost-sensitivity). Demo: `mockClient` routes `ask-leases` → a canned
    grouped answer, `demoAskPortfolio` now answers roof from facts + returns `needs_docs` for off-topic asks.
  - **4) Auto sign-out (migration `0062` + `idleLogout.js` + `AutoLogout.js` + Settings→Security picker):**
    `0062` adds nullable `user_preferences.auto_logout_minutes` (null=default 30, 0=off). Pure
    `idlePhase(lastActivity, now, minutes)` → active/warn/expired (WARN_SECONDS=60), unit-tested at the
    boundaries. `AutoLogout` (mounted in `Layout`, inert in demo / signed-out / when Off) stamps
    `localStorage['amlak:lastActivity']` (throttled ~1/10s, so activity in ANY tab counts), polls every 15s,
    shows a `useModalA11y` "Still there? …signed out in {n}s / Stay signed in" modal for the last 60s (any
    activity or the button resets), and on expiry does `queryClient.clear()` + `supabase.auth.signOut()`.
    Settings→Security gains an **Auto sign-out** card with an Off / 15 min / 30 min / 1 hour segmented picker
    (`getAutoLogoutMinutes`/`setAutoLogoutMinutes`, plain-English line; shown-but-inactive in demo).
  - **Files:** `supabase/migrations/0062_auto_logout_pref.sql` (new), `supabase/functions/ask-leases/index.ts`
    (new), `supabase/functions/ask-portfolio/index.ts`, `src/lib/{portfolio,api,idleLogout}.js` (idleLogout
    new), `src/components/{AutoLogout.js (new),Layout.js}`, `src/pages/{AskPage,SecuritySettings}.js`,
    `src/lib/demo/mockClient.js`, `src/App.css`, tests (`idleLogout.test.js` new; `portfolio.test.js` updated).
  - **Verified:** unit **303/303** (`vitest run`); `vite build` compiles. **Real-browser click-through 8/8**
    (system Chrome headless via playwright-core — the shared MCP browser was held by a concurrent session —
    against the demo dev server): roof chip → answer names the roof-billed tenant **from the facts** (the
    reported gap fixed); Clear answers empties the log; an off-topic question shows the 📄 docs button →
    canned grouped docs answer; Settings→Security shows the Auto sign-out picker with all four options —
    **zero console errors**. **Live verified:** `user_preferences.auto_logout_minutes` present; both edge fns
    deployed clean; `ask-leases` unauthenticated POST → **401** (RLS-gated, reads only the caller's own
    leases); site 200s (amlakre.com + www + workers.dev). **George: ask "which tenants pay for the roof?" —
    it now answers from the "Roof share billed" flag (flip that toggle On for the tenants whose leases make
    them pay), or click 📄 to have the lease documents read (~5–10¢).** Committed only this task's files.

- **2026-07-13** — **Receivables audit: calendar/term-aware rent tracking + "months behind" replaces 30/60/90
  aging** (George approved the plan — `~/.claude/plans/do-a-full-audit-floating-eagle.md`; full scope: bug
  fixes + overdue-model reframe + UI simplification; behind-on-rent = **in-app alert only**, no owner emails
  for monthly lateness). Deployed: DB migration `0061` (Supabase `awgrjmbcghdjgnqeiqkt`), `draft-invoice` +
  `send-reminders` edge functions redeployed, frontend Cloudflare version `23e569fb`. **$0 (no AI calls) · no
  tenant emails (in-app alerts only) · migration is a non-destructive view rebuild/append · the only data
  writes are Phase 4's two named repairs on unpaid/mistagged rows.** Tests **288/288** (was 265 — +19
  arStatus, +4 midYearRent; updated money/notification/sixMonth/camRecon). Migration pre-reviewed by the
  migration-reviewer agent (APPROVE).
  - **BUG 1 (urgent, root cause) — `v_invoice_balances` froze its `i.*` column list at the 0055 rebuild;
    0057 + 0060 added `overdue_notice_bucket` + `kind` to `invoices` without rebuilding it.** Live symptoms
    (all confirmed): `isAnnualInvoice()` read undefined → Ricki's monthly tracker showed **"No rent on file
    for FY 2026"** (its $985 reconciliation invoice was mistaken for the year invoice); the Reconciliation
    badge never rendered; and send-reminders' overdue sweep selected a non-existent column → **400'd every
    night since 7/09** (overdue owner emails silently never sent). `0061` DROPs+recreates the view with the
    byte-identical 0055 body (±5¢ dust clamp preserved) so the fresh `i.*` picks up both columns + any future
    ones; `security_invoker`/grants re-established. **Prevention:** added rule #7 to the migration-reviewer
    agent (any `add column` to a table a view selects `X.*` from must rebuild that view same-migration).
  - **BUG 2 — "overdue" was judged from the ANNUAL invoice's due date** (issue+30d), so from ~Aug 1 every
    tenant's entire remaining year read red. Replaced with a **months-behind** model: a month is *due* only
    once its 1st has arrived; behind = perMonth × monthsDue − amount_paid (≤$0.05 dust → not behind). A
    lump-annual payer is never "behind". Reconciliation invoices keep plain due-date overdue.
  - **BUG 3 — calendar-naive monthly model, three parts, all fixed by ONE shared term-aware schedule.**
    (3a) mid-year starts over-billed — **Infinite Mobile (lease_start 2026-07-01) was invoiced $36,561.97 for
    a 6-month tenancy (~$18,281 over)**; (3b) no today-awareness (a missed March looked like a not-yet-due
    December, no current-month marker, counters read "2/12" when only 7 were due); (3c) mid-year escalations
    billed the new rate all year. New `occupancyStart(lease, applied)` = `min(lease_start, earliest APPLIED
    escalation date)` distinguishes a genuinely new tenancy (step AT start → pre-months not owed) from a
    renewed-in-place lease (old applied steps → full year owed); `monthlyBases(escalations, base, year)` makes
    each month's rent era-aware. Extended `monthlyScheduleForYear` (abatement.js) with `occupancyStartIso` +
    per-month bases → out-of-term months become `{owed:0, outsideTerm:true}`, proration falls out. New pure
    **`src/lib/arStatus.js`** (`inTermMonths`/`monthsDueByNow`/`monthsBehindForInvoice`).
  - **The tracker↔invoice consistency guarantee:** new shared `buildLeaseSchedule({year, grossBase,
    otherAnnual, abatements, escalations, leaseStart, invoiceTotal})` in `api.js` builds the calendar/term-
    aware schedule, then **scales it to the invoice total when one exists** (penny-folded so Σ owed ==
    invoice total — preserves the 0055 penny invariant) so the monthly tracker and the invoice agree to the
    cent while staying term-aware. `getMonthlyRent`/`markMonthPaid`/`getPropertyMonthlyRoll` all route
    through it; `draft-invoice` + `invoiceTemplate` prorate to the owed months (note: "Prorated — lease
    begins {date} ({n} of 12 months)"). `0061` also **appends `lease_start` to `v_tenant_shares`** (append-
    only after the 0060 columns) so the roll builds schedules without an extra query.
  - **Reframe + gating (George's notifications-follow-settings rule):** `alerts.js` overdue-invoice alert →
    **"Behind on rent — {tenant}"** (warn 1mo / danger 2+) for annuals + a due-date "Reconciliation overdue"
    for recon invoices — both under the SAME `arOn` (receivables Settings toggle) gate. `summarizeAR` returns
    `{outstanding, count, tenantsBehind, amountBehind, byMonthsBehind:{m1,m2plus}}` (30/60/90 buckets gone);
    Dashboard AR foot → "N tenant(s) behind · $X" (danger only when N>0); ARSummary cards → Outstanding /
    Behind on rent / 1 month behind / 2+ months behind. `send-reminders` overdue email sweep filtered to
    **`kind='reconciliation'` only** (annual lateness is in-app only) — its per-owner `ar`-toggle check kept.
  - **UI (calendar-aware + declutter):** MonthlyRentTracker + PropertyRentRoll now read the calendar via
    `localDateIso` — month states `—` not-owed / `Free` abated / `✓` paid / **late** (amber) / upcoming, a
    ring on the current month, honest counters ("Paid {n} of {m} due · {b} behind"), and one-click catch-up
    ("✓ Mark paid through {month}" per tenant, "✓ Mark everyone paid through {month}" on the roll).
    InvoicesPanel: dropped 'draft', single **"Remove invoice"** (= void; voided collapse under "N removed —
    show"); LeaseDetailPage panel title "Receivables" → "Invoices & payments".
  - **Phase 4 — live-data repair** (the two named writes): Infinite Mobile's FY2026 invoice re-prorated to
    the 6-month figure **$18,280.99** (base $14,372.52 · CAM $213.00 · tax $3,695.47; balance $12,187.33) and
    its two $3,046.83 payments re-tagged period_month **1→7 / 2→8** (amounts unchanged — they were already
    the correct in-term monthly). **NOT executed** (destructive, needs George's separate OK): deleting the
    empty duplicate Infinite Mobile lease (created 6/27, re-imported 7/01 — double-counts SF/rent). One
    sentence back — "yes, delete the empty duplicate Infinite Mobile lease" — and it's gone.
  - **Files:** `supabase/migrations/0061_invoice_balances_rebuild.sql` (new), `src/lib/arStatus.js` (new),
    `src/lib/{abatement,escalations,alerts,api,emailTemplates,invoiceTemplate,dashboardWidgets}.js`,
    `src/lib/demo/{mockClient,store}.js`, `src/components/{MonthlyRentTracker,PropertyRentRoll,InvoicesPanel}.js`,
    `src/pages/{DashboardPage,LeaseDetailPage,PropertyFinancialsPage}.js`, `src/App.css`,
    `supabase/functions/{draft-invoice,send-reminders}/index.ts`, tests (`arStatus.test.js`,
    `midYearRent.test.js` new; money/notification/sixMonth/camRecon updated).
  - **Verified:** unit **288/288** (`vitest run`) incl. the mid-year integration tests vs the demo mock
    (July-start lease → 6 owed months, Jan–Jun unbillable, "✓ all" skips them; occupancyStart new-vs-renewed;
    mid-year escalation penny-true; holdover months stay owed) and the component renders. `vite build`
    compiles; both edge functions deployed clean. **Live post-push verified:** `v_invoice_balances` now
    exposes kind + overdue_notice_bucket; `v_tenant_shares` carries lease_start (col 22); Ricki's annual
    ($39,395.59) is now distinguishable from its $985.04 reconciliation; Infinite Mobile invoice reads
    $18,280.99 with payments on July + August. Live site 200s (amlakre.com + www + workers.dev). Committed
    only this task's files.

- **2026-07-13** — **Finances page fits the screen — no more scrolling right** (George: "can you make it so
  that i dont have to scroll right to get to the end of that page? use that design skill and make it look
  nice"). Deployed: frontend Cloudflare version `39e5dfbe`. **Frontend-only — layout/CSS, zero logic or math
  changes; no DB migration, no edge function, $0, no tenant emails.** Tests **265/265** (unchanged count —
  the component test's totals-row selector updated to the new DOM).
  - **1) Per-tenant breakdown rebuilt as a LEDGER, not a 13-column spreadsheet** (`TenantShareTable.js` +
    the `.ledger-*` CSS replacing the `table.grouped` rules in `App.css`, designed with the frontend-design
    skill inside the app's existing paper/serif language). One entry per tenant: identity on the left
    (name, "2,000 SF · 40.0% share", and the Invoice / ⚖ Reconcile / ✉ Statement actions moved UNDER the
    name — killing the widest column), six figure columns on the right (Base rent · Estimated · Taxes ·
    CAM · Roof · Difference) whose $/SF rides each figure's existing sub-line (the roof rider gets its own
    sub-line so long combos can't bleed into a neighbor). Header band, every entry, and the totals band
    share ONE grid template, so figures still align down the page — ~800px natural width vs ~1,300px
    before. The **Difference** column is styled as the entry's closing balance (display serif, signed
    gold/red, behind a hairline rule) — the one emphasized element. **Responsive for real:** below 880px
    the header band hides, each figure self-labels (labels are screen-reader-only on desktop), and figures
    wrap 3-across (2-across under 520px) — no sideways scroll at ANY width. The estimate editor now opens
    as a roomy full-width band under the row (same $/SF inputs + × SF preview) instead of the cramped
    150px cell. Two leaks caught in the browser pass and fixed: the global `button` uppercase/letter-spacing
    bled into the estimate click-target ("＋ SET ESTIMATE"), and the long est sub-line overflowed its column.
    Totals band also gained the Base rent sum (was an empty cell). All figures/logic/actions byte-identical.
  - **2) Monthly rent roll fits too** — the page's other wide panel. Its 12 month columns carried the
    generic 16px cell padding; a scoped `.rent-roll` rule tightens the month columns to 5px (tenant/last
    columns keep 16px), so Jan–Dec + Paid fit the panel at laptop width with no inner scrollbar.
  - **Files:** `TenantShareTable.js`, `App.css`, `camReconciliation.test.js` (totals selector `tr` →
    `.ledger-totals`).
  - **Verified:** unit **265/265** (`vitest run`); `vite build` compiles; **real-browser check at 1280px
    and 800px** (playwright vs the demo dev server): page + both panels report zero horizontal overflow
    (`scrollWidth == clientWidth`), estimate editor opens/saves, narrow reflow self-labels, **zero console
    errors** — screenshots reviewed at each pass. Live site 200s (amlakre.com + www + workers.dev).
    Committed only this task's files.

- **2026-07-13** — **Extractor reads estimated CAM/tax from the lease + the invoice/statement emails no
  longer break in Gmail** (George: "sometimes certain leases will have an estimated cam and tax can you make
  the AI extractor also look for that? also when i click the invoice button or statement button it formats
  weird in gmail can you fix that?"). Deployed: `extract-lease` edge function (Supabase `awgrjmbcghdjgnqeiqkt`),
  frontend Cloudflare version `3692adfe`. **$0 new AI cost** (the estimates ride the EXISTING supplement +
  analyst calls — no new model call), **no DB migration, no tenant emails, no destructive data.** Tests
  **265/265** (was 258 — +7 expenseEstimates).
  - **1) AI extractor reads estimated CAM/tax (and roof).** New `expense_estimates` array on the supplement
    schema — read RAW + basis (`per_month/per_year/per_sqft_year/…`), exactly the rent_schedule contract, so
    CODE does every ×12/×SF (never the model). **Schema-ceiling safe:** every item field is REQUIRED
    (non-nullable), so the whole array costs ZERO of the 16-union budget — the supplement stays at 15/16.
    New shared `estimateAnnualsFrom(estimates, sqft)` (`_shared/rentSchedule.js`, unit-tested from the same
    module the edge fn runs): first stated figure per charge wins, a 'combined' CAM+tax figure lands on cam
    only when no separate CAM figure exists, unusable rows (unknown basis, $/SF with no sqft) are skipped —
    better no prefill than a wrong one. Merged onto the extraction as field-shaped
    `est_cam_annual`/`est_tax_annual`/`est_roof_annual` (value + confidence + source_quote → the review form
    shows the AI badge and the quoted clause). Analyst brief's OTHER NOTABLE TERMS now asks for stated
    estimated charges, steering the form-filler to the clause.
  - **Review-form prefill with an exact round-trip:** `initialFromExtraction` (LeaseNewPage, now exported for
    the test) divides the annual estimate to the $/SF rate the form multiplies back at save — 6-dp quotient so
    an awkward figure ($10,000 over 1,077 SF) still saves as exactly $10,000.00, not $10,005.33; with no SF
    the annual prefills directly. `buildAiConfidence` carries the two est fields. Roof estimates are read +
    stored on the extraction but NOT silently saved (the form has no roof field — roof responsibility is a
    manual toggle; enter the roof estimate on the lease page after toggling it). Demo mock's canned extraction
    gained a stated "$3.50/SF per annum" CAM estimate (prefills 3.5) for parity.
  - **2) Gmail formatting fix — root cause: space-padded columns.** Both the invoice (`invoiceTemplate.js`)
    and the reconciliation statement (`buildCamReconciliationEmail`) aligned their tables with runs of spaces,
    which collapse in Gmail's proportional font (compose window AND received mail) → ragged "weird" columns.
    Both rebuilt as one self-labeled line per charge with NO alignment to break: invoice
    `• Base rent — $5,000.00/mo · $60,000.00/yr · $2.50/SF/mo · $30.00/SF/yr` (all four detail figures kept,
    per George's 6/30 preference; /SF figures omitted when no SF) + `AMOUNT DUE: $/yr ($/mo)`; statement
    `• CAM — billed $6,500.00 · actual $7,200.00 · difference +$700.00` + `BALANCE DUE: $X` /
    `REFUND DUE TO TENANT: $X`. Letterhead/BILL TO/dates unchanged in content, just unpadded. usd() is now
    sign-aware (`-$83.33`, not `$-83.33`). New regression invariant in the tests: **no run of two spaces
    anywhere** in either document — the "won't break in a proportional font" property itself.
  - **Files:** `extract-lease/index.ts` (schema + prompt + merge), `_shared/rentSchedule.js`
    (estimateAnnualsFrom), `LeaseNewPage.js` (est prefill + export), `mockClient.js` (demo extraction),
    `invoiceTemplate.js` + `emailTemplates.js` (proportional-safe rewrites), `expenseEstimates.test.js` (new),
    `reconciliation.test.js` (alignment tests → Gmail-proof assertions).
  - **Verified:** unit **265/265** (`vitest run`) incl. the round-trip-to-the-cent prefill case and both
    no-double-space invariants; `vite build` compiles; edge fn deployed clean; live site 200s (amlakre.com +
    www + workers.dev). **George: upload a lease that states estimated CAM/tax charges (~10–15¢, the normal
    per-lease read) — the Est. CAM / Est. taxes fields on the review screen arrive pre-filled with the quoted
    clause under them.** Committed only this task's files.

- **2026-07-13** — **Reconciliation math fix: the estimated/difference view now ties out and stays dormant
  until an estimate is typed** (George: "the current math doesnt look right to me … how is it getting an
  estimate of about 101 thousand if there are no estimates set?"). Deployed: frontend Cloudflare version
  `58a1ba99`. **Frontend-only — no DB migration, no edge function, $0, no tenant emails, no effect on any
  bill.** Tests **258/258** (was 257 — +1 "no-estimate → dormant totals" regression).
  - **The two symptoms George caught, one root cause each.**
    - **Phantom ~$101k "Estimated" total.** The Finances per-tenant table's **Totals** row summed every
      tenant's `fig.estTotal`, and for a tenant with NO estimate typed `reconcileFigures` fell back to that
      tenant's ACTUAL share (or its annual invoice's billed CAM+tax+roof) — so the Totals "Estimated (billed
      to tenant)" cell added up real actuals and printed them as an *estimate* (~$101k on George's live data),
      even though every individual row correctly read "＋ set estimate". No bills were affected — purely a
      misleading total.
    - **Difference didn't equal Estimated − Actual on screen.** The **Estimated column** displayed the current
      typed estimate (`billedComponents`), but the **Difference column** (and the Reconcile settlement)
      compared against the year invoice's frozen **snapshot** (0060's "snapshot-wins"). When the two differed
      (e.g. the demo seed, or George's case where his tenants' pre-feature invoices billed actuals), the
      on-screen subtraction didn't tie out — 18,800 actual − 18,000 shown estimate looked like +$800 but read
      +$700 because it was secretly using the $18,100 snapshot.
  - **Fix — one estimate basis everywhere + gate the view on an estimate being set.**
    - `reconciliation.js` `reconcileFigures({ share })` — dropped the invoice-snapshot preference; the estimate
      side is now **always the tenant's current typed estimate** (`billedComponents`, the exact figure the
      Estimated column shows), so `Estimated − Actual = Difference` always holds on screen, and the Reconcile
      settlement matches what the landlord sees. (Trade-off, flagged: reconciliation is no longer "immune to a
      later estimate edit" — editing the estimate now re-bases the true-up; for George that's the intuitive
      behavior, and the invoice PDF still records what was actually billed.)
    - `api.js` `reconcileCamTax` — settles against `reconcileFigures({ share })` (same basis; removed the now-
      unused `getYearInvoice` fetch), so the confirm dialog, the Difference column, and the created recon
      invoice are one number.
    - `TenantShareTable.js` — the Estimated total, the Difference column, and the **⚖ Reconcile** button now
      **only engage when an estimate is actually set** (`billed.anyEstimate`): a no-estimate tenant shows "＋
      set estimate", a dormant "—" Difference, and no Reconcile; the Totals "Estimated"/"Difference" cells read
      **—** when no tenant on the property has an estimate (killing the phantom $101k). Removed the dead
      `annualInvByLease`/`isAnnualInvoice` snapshot plumbing.
  - **Files:** `reconciliation.js`, `api.js` (reconcileCamTax), `TenantShareTable.js`, `reconciliation.test.js`
    (snapshot-basis test repurposed to assert the estimate basis; demo diff 700→800), `camReconciliation.test.js`
    (700→800 + new dormant-totals regression).
  - **Verified:** unit **258/258** (`vitest run`) incl. the component test mounting the real TenantShareTable —
    Bright Coffee shows Estimated $16,500 (+roof $1,500) and a Difference of **+$800** that now ties to
    18,800 − 18,000; City Dental / Northwind (no estimate) show "＋ set estimate", a "—" Difference, no
    Reconcile, and a "—" Totals estimate. `vite build` compiles; live site 200s (amlakre.com + www +
    workers.dev). Committed only this task's files.

- **2026-07-12** — **Follow-up on the CAM/tax estimates: $/SF entry, invoice alignment fix, invoice-style
  reconciliation statement** (George, same day: "the landlord should enter the prices in dollars per square
  foot … show the total number and the number per square foot like the actual column. the invoice format
  it a bit off. for reconcile i want it to be email format … similar to the invoice that explains the
  situation based on the numbers to the tenant"). Deployed: frontend Cloudflare version `81667426`.
  **Frontend-only — no DB migration, no edge function, $0, no tenant emails** (the statement still opens in
  the compose modal; nothing auto-sends). Tests **257/257** (was 255 — +1 invoice-alignment regression,
  +1 $/SF save round-trip).
  - **1) Estimates are now entered in $/SF (stored annualized — the `est_*_annual` lease columns and the
    whole billing spine are untouched).** The Finances inline editor's inputs became **CAM/Tax/Roof
    $/SF/yr** rates (prefilled from the saved annual ÷ the tenant's SF; placeholders = the actual $/SF)
    with a live "× 2,000 SF = $18,000.00/yr" preview; Save multiplies back to the annual figure. The
    lease-page fields and the new-lease form got the same treatment (labels flip to "$/SF/yr"; the
    lease-page hint shows the computed "= $X/yr"). A lease with **no square footage on file falls back to
    plain $/yr entry** everywhere — the one edge case. Display: the Estimated column now shows the billed
    total **plus a $/SF sub-line** ("$8.25/SF · + roof $1,500.00"), matching the actual columns.
  - **2) Invoice alignment bug fixed** (`invoiceTemplate.js`): the new "Property tax (2025 est.)" label is
    24 chars vs the fixed 22-char label column, so that row's four dollar columns shifted right ("Rent
    abatement (credit)" at 23 chars had the same latent off-by-one). The label column is now sized
    dynamically to the longest label; ui-verified every row at identical width with identical $-column
    end positions [39, 52, 65, 78].
  - **3) Reconciliation statement rebuilt as an invoice-style document** (`buildCamReconciliationEmail`):
    business letterhead → right-aligned `REC-{year}-{TEN}` statement number → statement date/period →
    BILL TO block → an aligned **CHARGE / BILLED (EST.) / ACTUAL / DIFFERENCE** table (signed per-line
    diffs) → TOTAL row → **BALANCE DUE** (or **REFUND DUE TO TENANT**) — followed by the "Dear {tenant}"
    letter explaining the outcome from those numbers (remit within 30 days / we will refund / settled
    even). Same `{subject, body, to}` contract, so the ✉ Statement button and `draftCamReconciliationEmail`
    needed no changes.
  - **Files:** `TenantShareTable.js` (EstimateCell $/SF editor + preview + $/SF sub-line),
    `LeaseDetailPage.js` + `LeaseForm.js` ($/SF entry with annual fallback), `invoiceTemplate.js` (dynamic
    label width), `emailTemplates.js` (statement document), `App.css` (`.est-preview`), both test files.
  - **Verified:** unit **257/257** (`vitest run`); **real-browser click-through 6/6** (ui-verifier, demo
    dev server): $16,500.00 est. + $8.25/SF sub-line; editor prefilled 3.25/5/0.75 with the ×SF preview;
    CAM 3.5 → $17,000.00/$8.50/SF live and back; invoice rows all 78 chars, columns aligned; Reconcile →
    "Owed $700.00 — invoiced" → statement modal shows the aligned 56-char table + "BALANCE DUE … $700.00"
    + the Dear-paragraph — zero console errors (it also caught a "SF SF" double-unit in the preview,
    fixed before deploy). Live site 200s. Committed only this task's files.

- **2026-07-12** — **Estimated CAM & tax billing + year-end reconciliation** (George approved the plan —
  `~/.claude/plans/need-to-add-a-jazzy-creek.md`; his picks: estimates typed **per tenant**, ONE combined
  Leases-page column with the in-depth detail on Finances, overpayments settled by **refund**, roof gets
  the identical estimate→reconcile treatment as its own separate line). Deployed: DB migration `0060`
  (Supabase `awgrjmbcghdjgnqeiqkt`), `draft-invoice` edge fn redeployed, frontend Cloudflare version
  `0d307b7d`. **$0** (no AI calls anywhere in the feature), **no tenant emails** (the reconciliation
  statement opens in the compose modal like every letter — nothing auto-sends), **no destructive data**
  (0060 is additive; the one structural change: 0055's `invoices_one_live_per_lease_year` unique index was
  REPLACED by two kind-scoped ones — constraint-only, verified created-before-dropped, no rows touched).
  Tests **255/255** (was 238 — +14 reconciliation, +3 component smoke). Migration pre-reviewed by the
  migration-reviewer agent (APPROVE); UI verified by a real-browser click-through (8/8, zero console errors).
  - **The concept (George's ask):** the true CAM is only known once the year closes, so during the year the
    tenant pays a typed **estimate**; the app tracks the **actual** share in the background, shows the live
    difference, and at year end a **Reconcile** button settles it — tenant underpaid → a reconciliation
    invoice for the shortfall; tenant overpaid → a refund George marks paid once he's paid the tenant back.
  - **Data (`0060_cam_tax_estimates.sql`):** `leases.est_cam_annual/est_tax_annual/est_roof_annual`
    (nullable — **null = that component keeps billing actuals exactly as before**, so all of George's real
    tenants bill byte-identically until he types an estimate; he can enter only the CAM estimate and let
    the known tax bill as-is). `v_tenant_shares` recreated appending those 3 columns (19–21; 0058 body
    otherwise identical, security_invoker re-asserted). `invoices.kind` ('annual' default backfills, |
    'reconciliation') + the two kind-scoped partial unique indexes. New owner-scoped `cam_reconciliations`
    (billed-est vs actual snapshot per component, signed `diff`, direction, refund open/settled state,
    linked `invoice_id`; unique lease+year; owner_all + require_aal2 policies — 0059 pattern).
  - **Billing spine flipped in ONE choke point:** `draft-invoice` now bills each component
    estimate-else-actual and returns `estimated` flags — so the Invoice modal, `ensureInvoice`, the monthly
    tracker, and the property rent roll all follow automatically. `getYearInvoice` +
    `getPropertyMonthlyRoll` filter `kind='annual'` (**the ÷12 gotcha:** a $700 true-up must never be
    mistaken for the year invoice and divided into monthly boxes — unit-tested). Invoice template tags
    "est." lines dynamically + notes "estimated charges are reconciled against actual expenses after year
    end"; monthly-roll previews use the same est-preferred math (`billedComponents`).
  - **Reconciliation core:** pure `src/lib/reconciliation.js` (`billedComponents` / `reconcileFigures`;
    est side = the year invoice's **billed snapshot** when one exists — immune to later estimate edits —
    else the current estimates; ±5¢ = even, the 0055 dust convention) — the ONE math both the live
    Difference column and the Reconcile action use. `api.js`: `reconcileCamTax` (idempotent per lease-year;
    tenant_owes → `kind='reconciliation'` invoice with the NET in total_amount (per-component diffs can be
    negative and invoice components are ≥0-checked; breakdown lives on the recon row + letter) → flows into
    AR/aging/the overdue alert + owner overdue emails automatically, all already gated by the `ar` Settings
    toggle — **no new notification gating needed**; landlord_owes → refund record, `markReconciliationRefunded`
    settles it; both log `cam_reconciled`/`cam_refunded` history events), `draftCamReconciliationEmail` →
    new `buildCamReconciliationEmail` letter (est/actual/difference table + "balance due in 30 days" vs
    "we will refund $X").
  - **UI:** Leases page — the CAM+tax column now shows the **billed figure** ("$16,500 est." + sub-line
    "actual so far $17,200"; Total rent follows; untouched look when no estimate). Finances per-tenant
    table — new **Estimated (billed)** column (click-to-edit inline: CAM/tax/+roof-when-responsible inputs
    saved onto the lease, placeholder = the actual it would fall back to) and a live signed **Difference**
    column ("+$700 tenant owes" / "−$X you owe tenant"; recomputes on every expense/CAM/contract/building
    edit via the existing `tenantShares` invalidations), totals row sums est/actual/net; per-row
    **⚖ Reconcile** (confirm names the figures) → outcome badge ("Owed $700 — invoiced/collected ✓/overdue",
    "You owe $X" + **Mark refunded**, or "Reconciled ✓" even) + **✉ Statement**. Estimate fields also
    editable on the lease page (beside the share override; roof one only when roof-responsible) + the
    new-lease form. Receivables panels tag `Reconciliation` invoices; History page labels the new events.
  - **Demo parity:** Bright Coffee seeded with estimates (6,500/10,000/1,500) — its saved inv-1 snapshot
    (18,100) vs actual share (18,800) demos a live **"+$700 tenant owes"** and the full Reconcile flow;
    City Dental stays estimate-free (demos the bill-actuals fallback). Mock: est columns on tenantShares,
    est-preferred demo invoice facts, kind-scoped 23505 + recon-unique emulation.
  - **Verified:** unit **255/255** (`vitest run`) incl. `reconciliation.test.js` (per-component fallback;
    both directions + dust→even; invoice-snapshot-wins; recon invoice created only when tenant owes;
    idempotent; refund settle; the ÷12 isolation; est. invoice labels) and `camReconciliation.test.js`
    (mounts the real TenantShareTable: est cell + inline editor + live diff + reconcile → badge + invoice).
    **Real-browser click-through 8/8** (vite demo dev server + playwright): combined Leases column, est
    edit round-trip, tax 25k→26k moved the Difference +$700→+$1,100 live and back, Reconcile dialog names
    billed 18,100 vs actual 18,800 → "Owed $700 — invoiced" + statement letter with the breakdown, lease
    receivables show BOTH invoices (78,100 paid + 700 Reconciliation) while the tracker stays $6,508.33/mo,
    "est." lines + reconciliation note on the invoice — zero console errors. **Live DB verified** (3 lease
    columns, view cols 19–21, kind, both indexes present/old one gone, both recon policies); live site 200s.
    Committed only this task's files.

- **2026-07-11** — **"📨 Send now": landlord letters send directly from the app under their business
  identity** (George's explicit OK — he asked that "the emails the landlord sends to their tenants come
  from their business email that they enter," while owner reminders keep coming from Amlak; the Resend
  domain `amlakre.com` verified earlier the same day is the prerequisite that made this safe). Deployed:
  new `send-tenant-email` edge function (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version
  `36dd662d`. **$0** (Resend free tier — 3,000 emails/mo; no AI calls), **no DB migration, no destructive
  data.** Tests **238/238** (was 236 — +2 sendNowEmail). **Landlord-initiated only — nothing auto-sends;
  a letter goes out solely on a Send-now click.**
  - **What changed for George:** every tenant letter (renewal notices, insurance requests, invoices) used
    to only *open Gmail* pre-filled for him to send himself. Now each compose screen also has a **"📨 Send
    now"** button that delivers the letter **directly from the app in one click** — no Gmail window. The
    Gmail / Other app / Copy / Download buttons all stay as alternatives (Gmail demoted from primary to a
    quiet secondary). Owner reminder/2FA/health emails are untouched (still from `reminders@amlakre.com` /
    `alerts@amlakre.com`).
  - **Sender identity (the one anti-spoofing constraint, handled the industry-standard way):** DMARC
    forbids a server sending literally "from" an address on a domain it doesn't own (e.g. a landlord's
    @gmail.com), so — exactly like DocuSign/QuickBooks — the message goes out as **From: `"{Business name}"
    <letters@amlakre.com>`** with **Reply-To: the corporation's business email** (the one in its Business
    profile). The tenant sees the **business name** as the sender; hitting Reply reaches the landlord's
    business inbox; delivery rides the verified amlakre.com domain so it passes spam checks. The business
    NAME is looked up under the caller's **own JWT** (`corporations.name` where `contact_email = reply_to`,
    RLS-scoped `.limit(1)` — a landlord can only ever borrow one of *his* business names; fallback "Amlak";
    sanitized header-safe, ≤60 chars).
  - **Edge fn `send-tenant-email/index.ts`** (13th `cors.ts` importer; keeps default `verify_jwt=true`):
    `cors(req)` + preflight (ask-portfolio scaffold). **Real auth is a separate gate** — an anon-key client
    with the caller's Authorization header → `auth.getUser()` → **401 if no signed-in user** (because
    `enforceRateLimit` FAILS OPEN on a limiter fault, so it's a cost guard, not the gate); then
    `enforceRateLimit(req, 10, 60)`. Validates `{to, subject, body, reply_to}` (email regex on to/reply_to,
    non-empty subject/body, subject ≤300, body ≤50k). Friendly **503** if `RESEND_API_KEY` unset → "use the
    Gmail button"; Resend rejection → friendly **502** → same fallback; success → `{id}`. Sends via the
    same Resend `fetch` pattern as `send-reminders`. From-address env-tunable via `TENANT_FROM_EMAIL`
    (default `letters@amlakre.com`); **no new secrets needed** — `RESEND_API_KEY` was already set.
  - **Frontend:** new shared `src/components/SendNowButton.js` (idle → "Sending…" → `✓ Sent to {to}` via
    `.badge good`; inline `.note-msg danger` on failure that points at the Gmail button; disabled until
    To/subject/body are all filled; `onSent` keeps the caller's existing logging). New
    `sendTenantEmail({to,subject,body,replyTo})` in `api.js` (next to `listSenderEmails`) → `invokeFunction
    ('send-tenant-email', …)`. Wired into `EmailComposeModal.js`, `NotificationEmailModal.js` (Send-now
    success fires the existing `onSend({to,subject})` so insurance-request logging still records; **"Mark
    sent & dismiss" stays manual** — a Send-now does NOT auto-dismiss the reminder), and `InvoiceButton.js`
    (footer, using its own from/to/subject/text). "Send from" field-notes reworded. Demo: `mockClient.js`
    routes `send-tenant-email` → `ok({id:'demo-email'})` (the sandbox never emails anyone).
  - **Verified:** unit **238/238** (`vitest run`) incl. new `src/components/__tests__/sendNowEmail.test.js`
    (mounts the real EmailComposeModal vs the demo mock → click Send now → `✓ Sent` + `onSend` fires with
    `{to,subject}`; Send now disabled with an empty To). `vite build` compiles. **Live function verified
    gated:** an unauthenticated POST → platform **401**; a valid anon JWT with no signed-in user → my
    `auth.getUser` **401 "Please sign in and try again."** Live site 200s. **Live end-to-end send NOT
    re-driven from here** — an authenticated send needs George's own logged-in session (I can't/shouldn't
    mint his JWT from the shell); the delivery path is the same verified Resend/amlakre.com setup already
    sending his owner emails. **George: click "📨 Send now" on any tenant letter to your OWN email to watch
    it land** (make sure each corporation's Business profile has its business email filled in — that's the
    reply-to + what names the sender). Committed only this task's files.

- **2026-07-11** — **Custom domain AmlakRE.com attached to the live app + edge-function CORS updated**
  (Part B of the approved plan `~/.claude/plans/precious-stirring-puppy.md`; George registered
  `amlakre.com` himself via Cloudflare Registrar on his own card — ~$10–12/yr, his purchase, nothing
  spent by Claude). Deployed: worker version `bf88d77c` (assets unchanged — config-only), **12 edge
  functions redeployed** (ask-doc, ask-lease, ask-portfolio, draft-invoice, extract-addendum,
  extract-annual-report, extract-contract, extract-insurance, extract-lease, send-2fa-code,
  trends-narrative, verify-2fa-code), secret `ALLOWED_ORIGINS` set. **No DB migration, no AI calls,
  no tenant emails.**
  - **App now serves on** `https://amlakre.com` + `https://www.amlakre.com` (Cloudflare Custom
    Domains, added via `wrangler.jsonc` `routes` with `custom_domain: true` — DNS + TLS auto-
    provisioned) **and still on** `https://amlak.akkawigeo-5.workers.dev`. Gotcha caught mid-deploy:
    adding `routes` silently disables workers.dev by default — fixed with explicit
    `"workers_dev": true` and redeployed, so the URL George + the beta user use never broke.
  - **CORS:** `_shared/cors.ts` `DEFAULT_ORIGINS` now lists amlakre.com (primary), www, and the
    workers.dev origin; `ALLOWED_ORIGINS` secret set to the same three. Verified live: an OPTIONS
    preflight with `Origin: https://amlakre.com` reflects that origin back.
  - **Verified:** apex + www + workers.dev all 200 and serve the app (`<title>Amlak</title>`); the
    apex initially looked dead from this machine — stale local negative-DNS cache from before the
    registration, confirmed fine against Cloudflare's authoritative NS + direct-IP HTTPS.
  - **Resend domain DONE (same day):** George added `amlakre.com` in Resend and used Resend's
    built-in "authorize via Cloudflare" flow (one-time OAuth — Resend added its own MX/SPF/DKIM
    records on the `send` subdomain + `resend._domainkey`, all DNS-only; no manual paste needed,
    no ongoing access). Domain shows **Verified**. Secrets set: `REMINDER_FROM_EMAIL=
    reminders@amlakre.com` + `HEALTH_FROM_EMAIL=alerts@amlakre.com` — covers send-reminders,
    send-2fa-code (falls back to REMINDER_FROM_EMAIL), and health-check; no code change, no
    redeploy needed (secrets restart the functions). Verified end-to-end: a one-time test email
    from `reminders@amlakre.com` to George (owner — allowed) accepted by Resend (id `9a9049a1`).
    All owner emails are branded from now on. Emailing REAL TENANTS from the server remains a
    separate feature needing George's explicit OK — the domain is the prerequisite, not the trigger.

- **2026-07-11** — **"Clear history" button on the property History page + the Leases tab renamed
  "Portfolio"** (George approved the plan — `~/.claude/plans/precious-stirring-puppy.md`; the plan's
  third part, the AmlakRE.com domain, is a separate collaborative runbook George drives — nothing of
  it shipped here). Deployed: frontend Cloudflare version `545aee6b`. **Frontend-only — no DB
  migration, no edge function, no AI calls, $0, no tenant emails.** Tests **236/236** (was 234 —
  +2 clearPropertyHistory).
  - **Clear history (Part A):** each property's "Lease & tenant history" timeline now has a
    **"Clear history"** button (shown only when events exist, disabled while clearing) that
    permanently deletes that property's `history_events` after a confirm that names the consequences
    — including that it also clears the "📨 Last requested" insurance markers (same table). Scope
    guardrails: the "Expired & renewed leases" archive and closed-year snapshots are untouched. New
    `clearPropertyHistory(propertyId)` in `api.js` (beside `deleteExpiredLease`); RLS `owner_all`
    scopes the delete, demo mock needed zero changes. Invalidates `['historyEvents', propId]` +
    `['insuranceRequests']`.
  - **Portfolio rename (Part C):** label-only — the route stays `/leases` so every deep link keeps
    working. Sidebar label + collapsed-rail tooltip (`Sidebar.js`), `TITLES.leases`
    (`CorporationsPage.js` — its h1 "Corporations" now reads naturally under a Portfolio tab), and
    the breadcrumb root in `PropertiesPage` / `LeasesPage` / `LeaseNewPage` / `LeaseDetailPage` /
    `ContractsPage`.
  - **Verified:** unit **236/236** (`vitest run`) incl. new `clearPropertyHistory.test.js` (wipes only
    that property's timeline incl. its insurance-request trail; other property + expired-lease archive
    untouched). **Real-browser click-through** (shared MCP browser held by a concurrent session again,
    so drove system Chrome headless via the existing playwright-core against a local demo dev server):
    **11/11** — sidebar reads Portfolio (no "Leases"), tab lands on the corporations grid at `/leases`,
    breadcrumb roots read Portfolio, Clear history shows with events → confirm names Maple Plaza +
    "can't be undone" → timeline empties to "No recorded changes yet" → button hides → expired archive
    2 before/2 after → snapshots still present — zero console errors. Live site 200s; deployed bundle
    carries the new strings. Committed only this task's files.

- **2026-07-11** — **Additional-insured notice: center pop-up + persistent red banner on a tenant
  certificate that doesn't name the landlord** (George: the current amber "No" badge is "pretty subtle";
  he chose a MIX of a quickly-dismissible center pop-up AND a red banner, dismissal quiet-until-the-cert-
  changes, with an email button — plan `~/.claude/plans/for-the-insurance-section-modular-bonbon.md`).
  Deployed: frontend Cloudflare version `a5a56d8c`. **Frontend-only — no DB migration, no edge function,
  no AI calls, $0, no tenant emails** (the letter opens in the compose modal; nothing auto-sends).
  Tests **234/234** (was 221 — +10 insuranceNotices, +3 render smoke).
  - **What shows now** (tenant Insurance section, when `additional_insured !== true` — explicit "No" AND
    "not stated on the document" both warn, same rule as the old badge): (1) a **center pop-up** the
    moment the tenant's policy loads — "⚠ Not listed as additional insured", names the insurer, explains
    the risk; Dismiss / ✕ / Escape closes it; (2) a **persistent red banner** on the policy ("You are not
    listed as additional insured on this certificate") that stays after the pop-up is dismissed; (3) the
    badge upgraded from amber "No" to red **"No — not listed"**. Pop-up + banner each carry
    **"✉ Request corrected certificate"** → a new professional letter (`buildAdditionalInsuredRequestEmail`,
    subject "Additional Insured Endorsement Needed — {property}") asking the tenant's agent to issue an
    endorsement naming the landlord; sending logs the `insurance_requested` history event ("📨 Last
    requested" + property History both update). The pop-up's email button also dismisses it.
  - **"Quiet until the cert changes" mechanic:** dismissal is stored in the existing `alert_states`
    dismiss store (server-synced, cross-device, works in demo via the mock's generic table handling) under
    key `addins:{policy.id}:{expiry_date}` (new pure `src/lib/insuranceNotices.js` —
    `missingAdditionalInsured` + `additionalInsuredAlertKey`). Replacing a policy updates the SAME row
    (`saveInsurance`), so keying on the expiry makes a renewed cert (new expiry) that still omits George
    **re-arm the pop-up**; a cert that names him clears everything (condition false). The pop-up renders
    only after the alert-states query resolves — no flicker on an already-dismissed cert.
  - **Files:** `InsuranceVault.js` (banner + badge + new `AdditionalInsuredPopup` on the shared
    modal-scrim/`useModalA11y` pattern; `onRequestRenewal(policy, reason?)` now passes an
    `'additional_insured'` reason), `LeaseDetailPage.js` (`renewalPolicy` is now `{policy, reason}`;
    reason branches to the new letter + "Request corrected certificate" title — the expired/current
    renewal-request flow is unchanged), `emailTemplates.js` (new letter on the `letter()` scaffold),
    `insuranceNotices.js` (new), demo `store.js` (Bright Coffee's ins-2 flipped to
    `additional_insured: false` + its policy_text line, so the pop-up/banner are demoable; City Dental
    keeps demoing the expired-cert flow). **Settings gating free:** everything lives inside the
    Insurance-feature-gated panel; no new dashboard alert or owner email, so nothing to add in
    buildAlerts/send-reminders/Ask AI.
  - **Verified:** unit **234/234** (`vitest run`) incl. `insuranceNotices.test.js` (warn on false/null,
    quiet on true/none; key stable per cert, flips on expiry change = the re-arm guarantee; letter
    content) and `insuranceAdditionalInsured.test.js` (mounts the real InsuranceVault against the demo
    mock: pop-up + banner + badge, dismiss persists across remount, reason callback, compliant cert
    quiet). **Real-browser click-through** (the shared MCP browser was held by a concurrent session, so I
    drove system Chrome headless via playwright-core, installed `--no-save`, against a local demo dev
    server): 17/17 checks — pop-up on open naming Harbor Casualty, email button → modal with the exact
    subject/recipient/letter, dismissal sticks while the banner stays, Escape works, City Dental shows no
    notice and its "Request renewed certificate" (expired) flow still opens the old letter — zero console
    errors. `vite build` compiles; live site 200s. Committed only this task's files.

- **2026-07-10** — **Live-data repair (beta user fakkawi3@gmail.com): GENA promoted from a property under
  NASA Property to its own corporation; the property renamed "Joliet"** (George approved the plan —
  `~/.claude/plans/the-user-under-fakkawi3-gmail-com-serene-breeze.md`). **DB-only** — no code change, no
  deploy, no migration (one-off row repair, Supabase `awgrjmbcghdjgnqeiqkt`), **no money, no tenant emails,
  nothing deleted**. The user had created "GENA Property, LLC" as a *property* inside his "NASA Property"
  corporation. One atomic statement (insert + 2 updates): created corporation **GENA Property, LLC**
  (`e44da7bf-c53d-4dc9-8e35-df80b9a63db3`); moved property `d70b45c6…` onto it and renamed it **"Joliet"**
  (address kept: 2545 Plainfield rd; same row id, so its whole subtree rode along); repointed the 3
  `renewal_applied` notifications' `corporation_id` NASA→GENA so their deep-links stay right. **Verified
  live:** GENA → Joliet holds all 4 leases (Eye 2 Eye, Mario Jirjess (Cards), Mario Thaeir Jirjess, Ruiz
  Saldivar Victor) + 10 history events; `v_property_totals`/`v_tenant_shares` still serve the property;
  NASA → Pershing Plaza (9 leases) untouched; the one Pershing notification correctly stays on NASA. The
  new corporation's Business-profile fields (address/contact) start empty — the user can fill them via the
  corporation card's "Business profile" button.

- **2026-07-09** — **Annual reports: a new AI-read filing-deadline tab on every corporation + a
  1-month reminder (bell + owner email)** (George approved the plan —
  `~/.claude/plans/we-also-need-to-snappy-gizmo.md`). Deployed: DB migration `0059` (Supabase
  `awgrjmbcghdjgnqeiqkt`), new `extract-annual-report` edge function, `send-reminders` redeployed,
  frontend Cloudflare version `4accb8fc`. **Costs money** (George approved, disclosed): one small Haiku
  read per uploaded report ≈ **1¢ or less** (no transcription call — the cheapest possible read);
  manual date entry is **$0**; **no recurring cost**. **No tenant emails** (owner-only), **no
  destructive data** (0059 is a brand-new additive table). Tests **221/221** (was 161 — +9
  annualReportAlerts, +3 corp/modal render smoke; sibling sessions had already pushed the count up).
  - **What George asked:** every corporation must file a state annual report yearly. He wanted an
    **"Annual report" button on each corporation card** (next to "Business profile") where he uploads
    the report; the **AI reads only one thing — the date it must be filed each year**; and the app
    **reminds him 1 month ahead, every year**. No other details extracted. Two decisions he made:
    notification = **dashboard bell + one email to him at the 1-month mark**; and **if the deadline
    passes unfiled the alert turns red "Overdue" and stays** until he clicks "Mark filed" (which rolls
    the date forward a year and re-arms next year's reminder).
  - **Data (`0059_annual_reports.sql`):** new owner-scoped `annual_reports`, **one row per corporation**
    (unique index on `corporation_id`) — `due_date`, `last_filed_date`, `docs jsonb` (`{path,
    uploaded_at}` so every year's report stays on file), `due_notice_bucket` (email dedupe, exact 0057
    pattern). RLS = `owner_all` PERMISSIVE **plus** the `require_aal2` RESTRICTIVE policy every other
    owner table carries (0052) — dormant until 2FA is enrolled. Additive/idempotent; verified live (9
    columns + both policies present).
  - **Edge fn `extract-annual-report`:** clone of `extract-insurance` **minus** the transcription call
    (nothing to Q&A here), single field `due_date`. The landlord's LOCAL today is injected so a
    recurring rule ("by April 1 each year", "anniversary of incorporation") resolves to the NEXT
    upcoming occurrence; returns null / never guesses if no deadline is stated. Haiku 4.5, vision path
    for uploads / paste-text path otherwise, rate-limited, 20 MB guard.
  - **Frontend:** new `src/components/AnnualReportModal.js` (upload/paste → AI pre-fills the date field
    for review → Save appends the doc to `docs[]` + saves the date; a plain date input for $0 manual
    entry; **"✓ Mark filed"** rolls the deadline +1 year; "Reports on file" list with Open buttons).
    `CorporationsPage.js` gained the second `corp-edit` pill ("Annual report", `DocIcon`) wrapped in a
    new `.corp-actions` flex span (App.css). `api.js` — `getAnnualReport` / `listAnnualReports` /
    `saveAnnualReport` (upsert; **nulls `due_notice_bucket` when the due date changes** so the reminder
    re-arms) / `markAnnualReportFiled` (stamps today, advances the date) / `extractAnnualReport`;
    `fetchAlertData` now also pulls `annual_reports` + `corporations (id,name)`. New pure
    `src/lib/annualReports.js` `advanceDueDate` (+1 yr, Feb-29 → Feb-28 clamp).
  - **Notifications:** `alerts.js` — new `focus:'annual_report'` section, shown **only within 31 days**
    (warn "Within 1 month"), past due → **red "Overdue", always shown** until filed; **`alertKey`
    gained a `report_id` anchor** (`a.contract_id || a.report_id || a.lease_id`) so two corps due the
    same day don't collide. `DashboardPage.js` — clicking the alert routes to the corporations grid
    (`/leases`); **no ✉ button** (no outside recipient — like the landlord's own insurance).
    `send-reminders` — new owner-email sweep (single **1-month** threshold per George, deduped by
    `due_notice_bucket`, **not** gated by any Settings module — filing is core). Past-due sends no email
    (the red bell covers it).
  - **Demo parity:** `store.js` seeds one `annual_reports` row (Acme Holdings due ~3 weeks out → the
    demo bell shows the 1-month alert; Northwind has none). `mockClient.js` — canned
    `extract-annual-report` route (returns a due date ~2 months out) + the generic mock QB handles the
    new table.
  - **Verified:** unit **221/221** (`vitest run`) incl. `annualReportAlerts.test.js` (45d → no alert;
    ~20d → warn "Within 1 month"; past due → red "Overdue" still shown; two corps same day → distinct
    keys; `advanceDueDate` +1yr + Feb-29 clamp) and `corporationsAnnualReport.test.js` (2 render smoke
    tests: the "Annual report" button on both corp cards + the modal reading the seeded record / empty
    state). `vite build` compiles (785 modules). **Live DB verified:** table + 9 columns + both RLS
    policies present; migration 0059 applied clean. Live site 200s. **Note:** the shared Playwright
    browser was held by a concurrent session, so the live-browser click-through wasn't re-driven — the
    jsdom render tests mount the real modal + corp card against the demo mock in its place. Committed
    only this task's files (left the untracked `.claude/` tooling alone).

- **2026-07-09** — **Follow-up: the downloadable rent-roll Excel now shows holdover tenants AND vacancy too**
  (George: "i didn't see the vacancy or the lease that needs an extension as holdover listed in the
  downloadable rent roll excel file"). Deployed: frontend Cloudflare version `61eac44b`. **No DB, no edge
  function, no money, no tenant emails.** Tests **209/209** (was 201 — +8 rentRollExcel).
  - **Root cause:** the on-screen roll got the holdover + vacancy fix (0058, prior entry) but the **Excel
    export is a separate code path** (`src/lib/rentRollExcel.js`, built from `fetchSearchIndex` leases +
    properties, NOT the view). It (a) hard-filtered `leases.filter(l => l.is_active !== false)` — dropping
    every held-over/outdated tenant from the workbook — and (b) never rendered a vacancy row at all.
  - **Fix:** extracted a pure, exported `rentRollRows(property, leases, now)` that builds the ordered data
    rows — tenant rows first (sorted by name), then a **"Vacant space"** row when `building_sf − ALL leases'
    SF > 0` (the same figure the Overview/Leases page use since 0049). Holdover leases are **included and
    flagged**, never dropped: a lease with `is_active === false` OR past its term end gets `kind:'holdover'`,
    an amber row fill, `In Term? = "Holdover"`, and a Notes prefix **"Expired — held over"** (+ "· needs
    extension" when `is_active===false`) — mirroring the on-screen badge. The vacant row is muted italic,
    `In Term? = "Vacant"`, "Unleased — nothing to collect", no rent. `downloadRentRollXlsx` dropped the
    `is_active` filter (so a property whose leases are ALL outdated still gets a sheet) and now buckets ALL
    leases by property. `addPropertySheet` just maps `rentRollRows` output onto the COLS by key and styles
    by `kind`; the summary occupancy/rent/Wtd-PSF now correctly count held-over tenants too (they were
    under-counted before). Both callers (`LeasesPage` per-property, `DashboardPage` portfolio-wide) already
    pass all leases + `building_sf`, so no caller change.
  - **Verified:** new `src/lib/__tests__/rentRollExcel.test.js` (8 tests — holdover incl. is_active=false and
    past-term, "needs extension" wording, in-term untouched, vacant row = building−leased & last, no vacancy
    when fully leased / no building size, purity). Full suite **209/209** (`vitest run`), `vite build`
    compiles, live site 200s. Committed only this task's 2 files. (Live-browser download not re-driven —
    the pure `rentRollRows` unit tests cover the row logic; the styling is unchanged plumbing.)

- **2026-07-09** — **Rent-roll holdover sync + Leases-page CAM/tax & Total columns + sorting/drag + a
  per-lease Address box (replacing the second-email feature)** (George approved the plan —
  `~/.claude/plans/make-sure-that-the-shiny-platypus.md`). Deployed: DB migration `0058` (Supabase
  `awgrjmbcghdjgnqeiqkt`), `extract-lease` edge function redeployed, frontend Cloudflare version `d86de65b`.
  **No money** (the address rides the existing supplement extraction call — zero new AI cost), **no tenant
  emails**, **no destructive data** (0058 is two additive nullable columns + a non-destructive view replace).
  Tests **201/201** (was 178 — +16 leaseSort, +3 holdover-roll, +4 render smoke tests).
  - **1) Rent roll now shows holdover/outdated tenants (the core ask).** Root cause: the monthly rent roll is
    built from `v_tenant_shares` (`getPropertyMonthlyRoll` → `getTenantShares`), and that view filtered
    `where l.is_active` (0042) — so a lease flagged `is_active=false` ("Outdated — needs extension") vanished
    from the roll even though the Leases page/Overview still counted it. `0058` recreates `v_tenant_shares`
    WITHOUT the `is_active` filter (body + `periods` CTE), **appends** `is_active` / `lease_termination_date` /
    `premises_address` (create-or-replace can only append, so the 15 prior columns keep their exact 0042 order),
    switches the active-SF fallback-denominator subquery `pt` to a `left join` (so a property whose leases are
    ALL outdated still surfaces its holdover rows), and keeps `pt` active-only so **no existing tenant's
    CAM/tax/roof bill changes**. `getPropertyMonthlyRoll` carries `is_active` + `lease_termination_date` onto
    each roll row; `PropertyRentRoll.js` shows an amber **"Expired — held over"** badge (adds "· needs
    extension" when `is_active=false`) with a title explaining rent still collects until removal. **Side
    benefit:** the lease-page MonthlyRentTracker + `draft-invoice` now work for a holdover lease too (the share
    row exists). **Live-verified:** George's real outdated tenant ("beauty and barber shop", term ended
    2025-05-31) now returns a share row (was 0 holdover rows before, 1 now) with its correct CAM/tax split;
    every active tenant's figures unchanged.
  - **Vacancy row (George's follow-up).** The roll also shows a muted **"Vacant space · {sf} SF — nothing to
    collect"** final row (months as non-clickable "—", excluded from "✓ all"/Paid count), driven by
    `v_property_totals.vacant_sf` (the same building-minus-all-leases figure the Overview/Leases page use since
    0049), passed from `PropertyFinancialsPage.js`.
  - **2) Leases page: CAM+tax and Total-rent columns.** Each `LeaseRow` now shows **"CAM + tax"** and
    **"Total rent"** (= base + CAM + tax + roof, matching the real invoice, with a $/SF sub-line) next to Base
    rent, pulled from `getTenantShares(propId, currentYear)`. "—" with a hint when no expenses are entered for
    the year. `.lease-row` grid widened to 7 columns (empty-slot vacancy row keeps its own grid).
  - **3) Sorting + drag-and-drop.** A sort bar (Term ending · Base rent · $/SF · Total rent · Address · Custom
    order) with an ↑/↓ direction toggle; nulls/blanks always sort last in BOTH directions. New pure
    `src/lib/leaseSort.js` (`LEASE_SORTS` + `sortLeases`). Custom order = HTML5 drag-and-drop; dropping a row
    reorders + persists per-property. Saved to `user_preferences.lease_sort` (jsonb) via new
    `getLeaseSort`/`setLeaseSort` (merge-patch so mode/dir and per-property manual orders don't clobber each
    other), React Query key `['leaseSort']` with optimistic updates. `api.listLeases` keeps its `byTermEnd`
    default (property cards / Excel export untouched).
  - **4) Address box replaces the second email (George: "remove it completely").** New nullable
    `leases.premises_address` (0058); `create_lease_tx` populates it automatically via `jsonb_populate_record`
    (no RPC change) and `LEASE_LIST_COLS` swapped `tenant_email_2` → `premises_address`. The extractor reads it
    in the existing `SUPPLEMENT_SCHEMA` (swapped `tenant_email_2` → `premises_address` — **union-neutral**, no
    schema-ceiling risk) with a prompt for "the leased premises' street address, never the landlord's notice
    address". The **Second email** field became an **Address** field on the review form (`LeaseForm.js`) + lease
    page (`LeaseDetailPage.js`) + review mapping (`LeaseNewPage.js`). The Primary/Second/Both send picker is
    gone: deleted `RecipientField.js` and un-wired it from `EmailComposeModal.js` / `NotificationEmailModal.js`
    / `InvoiceButton.js` back to a plain "To" line. **Data-safe:** the `leases.tenant_email_2` /
    `notifications.email_to_2` columns + trigger stay in the DB (1 live lease has a 2nd email) — simply unread.
  - **Demo parity:** `mockClient.js tenantShares` includes outdated leases + the 3 new fields (active-only
    fallback denominator, mirroring the SQL); `store.js` seeds premises addresses; `user_preferences` Just Works
    through the mock's generic table handler, so demo sorting persists too.
  - **Verified:** unit **201/201** (`vitest run`) incl. two **render smoke tests** that mount the real
    `PropertyRentRoll` (holdover badge + vacancy row) and `LeasesPage` (CAM+tax/Total columns + sort bar) against
    the demo mock; `vite build` compiles (783 modules); live DB confirmed the 3 new view columns in order + the
    holdover tenant now returns a share row + `user_preferences.lease_sort` present; live site 200s. **Note:** the
    shared Playwright browser was held by a concurrent session, so the live-browser click-through wasn't run —
    the jsdom render tests cover the same components instead. Committed only this task's files (left the
    untracked `.claude/` tooling alone).

- **2026-07-09** — **Follow-up: the "Request certificate" button now shows on ANY tenant policy on file**
  (George couldn't see it — all his live tenant certs are current/2027, and the button only appeared on an
  expiring/expired one; his only expired policy is his own building/landlord policy, which has no ✉). Deployed:
  frontend Cloudflare version `fe7e2a3a`, commit `5908c70`. No DB/edge/money/tenant-emails. Now: a prominent
  **"✉ Request renewed certificate"** warning box when the tenant cert is expiring/expired, and a quiet
  **"✉ Request updated certificate"** action whenever a current cert is on file. `buildInsuranceRenewalRequestEmail`
  wording adapts — "expired on {date}" (compliance ask) vs a neutral "…on file, with coverage through {date} …
  requesting your most recent certificate" that never sounds alarmist for a far-from-expiry policy (subject
  flips too). Files: `InsuranceVault.js` (button condition `status?.stale` → `policy`), `emailTemplates.js`,
  `LeaseDetailPage.js` (modal title adapts). Tests **178/178**; verified in demo the amber/red policies show the
  renewed-cert button; live bundle carries the new copy, site 200s.

- **2026-07-09** — **Notifications: full audit + synced to the Settings switchboard + expiry-focused
  additions** (George approved the plan — `~/.claude/plans/i-want-to-go-federated-whale.md`). Deployed: DB
  migration `0057` (Supabase `awgrjmbcghdjgnqeiqkt`), `send-reminders` edge function redeployed, frontend
  Cloudflare version `24435051`, commit `e7593e3`. **No money** (owner-only emails on the existing Resend
  setup; zero AI calls), **no tenant emails** (every tenant letter stays behind a ✉ click), **no destructive
  data** (0057 is two additive nullable columns). Tests **178/178** (was 161 — +17 gating tests).
  - **What George asked (three rounds):** (1) audit every notification + how far ahead it fires; (2) add
    notifications a landlord needs and **tie them to the Settings page** so hiding a module silences its
    notifications everywhere; (3) focus insurance on **policies EXPIRING** (not "no policy on file"), add a
    professional **"your certificate expired — please send the renewed one"** tenant email with neat UI; and
    (4) **link the notifications to the emails**: show WHICH email they go to, guarantee he's never emailed
    about something he hid, and **explain it in Settings**.
  - **The audit (4 channels, verified in code):** dashboard alert list (`buildAlerts`) — escalations / lease
    ending / renewal-notice / contract ending / insurance expiry (both landlord + tenant), 6 months out; +
    overdue invoices (until paid). Bell (stored) — renewal Yes/No prompt (6mo), escalation-applied, key-date
    copies (1mo/2wk/1wk). Owner emails (daily 13:00 UTC cron, Resend live) — lease dates 30/14/7d, insurance
    1mo/2wk/1wk/at-expiry. Health email — backend only. **Gap closed:** nothing respected the feature toggles.
  - **Part 1 — every notification now obeys Settings.** `buildAlerts(data, states, now, {features,
    hiddenWidgets})` gates insurance (+ chase-up) by the **Insurance** feature, contract alerts by
    **Service contracts**, overdue-invoice + free-rent alerts by the **Outstanding (receivables)** display
    toggle; core lease dates never gated (`src/lib/alerts.js`; `DashboardPage.js` passes `useFeatures().enabled`
    + hidden set, folded into the `['alerts', …]` query key so a toggle re-filters instantly). Server side:
    `send-reminders` loads all `user_preferences` once/run and skips insurance/contract/overdue-rent emails for
    owners who toggled them off. **Ask Amlak** (`portfolio.js`) omits a switched-off module's facts entirely
    (off ≠ "none on file") and folds the enabled set into `snapshotFingerprint` (v3) so cached answers can't
    leak a hidden section; `AskPage.js` drops the matching suggestion chips and re-keys the snapshot query.
  - **Part 2A — the headline "policy expired → send the renewed certificate" flow.** New
    `buildInsuranceRenewalRequestEmail` (`emailTemplates.js`, on the shared professional `letter()` scaffold) —
    names the policy on file + insurer, "expired on {date}" vs "set to expire on {date}", asks for the renewed
    cert naming the landlord as additional insured. `InsuranceVault.js`: an expiry status **badge** on every
    policy card (green Current / amber Expiring soon / red Expired) and, on an expiring/expired **tenant**
    policy, a prominent **"✉ Request renewed certificate"** button → the existing `EmailComposeModal` prefilled
    with the new letter (logs the `insurance_requested` history event, so "📨 Last requested" updates). The
    dashboard tenant-insurance alert's ✉ (`draftAlertEmail`) now uses the same expiry-aware letter; the
    landlord's own building-policy alert still has no ✉ (no outside recipient).
  - **Part 2B — new alerts.** Free-rent period ending within a month (`rent_abatements`; calm info→warn, owner
    heads-up, no tenant email); holdover wording (a still-active lease past term end reads "Tenant in holdover"
    not a generic overdue); insurance chase-up (a cert requested 21+ days ago with no policy saved/updated
    since → "renewed certificate not received", ✉ re-opens the letter). `fetchAlertData` now also selects
    rent_abatements, insurance_requested events, and policy created/updated stamps.
  - **Part 2C — new owner-email sweeps** in `send-reminders`, same 1mo/2wk/1wk/ended cadence + once-per-threshold
    dedupe as insurance: **contract expiry** (via new `service_contracts.end_notice_bucket`, re-armed by
    `updateServiceContract` when the end date changes) and **overdue rent** at 1 day / 1 week / 1 month late
    with the exact balance (via new `invoices.overdue_notice_bucket`; no reset needed — a paid invoice drops out
    of `v_invoice_balances`). Both gated by the owner's Settings toggles.
  - **Part "link + explain" (George's 4th ask) — new "Notifications & emails" card** at the top of Settings →
    Display & features (`DisplaySettings.js`): shows **"Reminder emails go to {your sign-in email}"** (live from
    `useAuth().user?.email`; demo shows a "no emails in demo" line), a plain-English schedule of what's emailed
    and when, and the promise **"Anything you turn off below is silenced everywhere — dashboard alerts AND
    emails. You'll never be emailed about something you've hidden"** + the reminder that tenants are never
    emailed automatically. Per-toggle hints (`features.js`/`dashboardWidgets.js`) gained "…also silences its
    reminders and emails."
  - **Deliberately deferred (flagged):** rent-renegotiation date as a dashboard alert (needs the date promoted
    out of `extraction_raw` first), "rent due soon" pre-due notices (noise for annual invoices), sign-in
    security alerts.
  - **Verified:** unit **178/178** (`vitest run`), `vite build` compiles, and end-to-end in demo with a real
    browser — City Dental's seeded lapsed cert shows the red **Expired** badge + **✉ Request renewed
    certificate**, and the compose modal opens with the professional "Expired Certificate of Insurance — Maple
    Plaza" letter naming Summit Indemnity + the expiry date; the Settings card renders the schedule + promise;
    toggling **Insurance off** dropped the 3 insurance alerts (8→5 active) AND made Ask Amlak reply "the
    Insurance module is turned off in Settings" — zero console errors. **Live DB verified:** both 0057 columns
    present. Live site 200s. Committed only this task's files (left the untracked `.claude/` tooling alone).

- **2026-07-07** — **Project renamed Amlak → "Lease Extractor V2" + GitHub repo made PUBLIC** (George is
  submitting it and wants reviewers to read the source). **⚠️ THE REPO IS NOW PUBLIC** —
  `GeorgeAkkawi/lease-extractor-v2` (was `my-dashboard`; old URL 301-redirects). **Never commit a secret**:
  real keys live only in `.env.local` / `.env.secrets.local` (gitignored) and Supabase edge-function
  secrets. `.env.production` is committed but holds ONLY the public `sb_publishable_` key + the
  `GENERATE_SOURCEMAP` flag (the block-secrets hook still guards it). Before flipping public I audited the
  full tree AND git history — zero service-role keys / API keys / passwords / private keys anywhere.
  - **Rename (commit `e56f01b`):** all user-visible "Amlak" → "Lease Extractor V2" (sidebar wordmark + "L"
    mark, browser `<title>` + meta description, Login/2FA headings, Excel `wb.creator`, the insurance-email
    footer) and the **"Ask Amlak" assistant → "Ask AI"** (sidebar nav, AskPage, README bullet); `package.json`
    name → `lease-extractor-v2`; internal comments updated. **Left untouched on purpose:** applied SQL
    migrations (immutable) and edge-function internals (avoid deployed-vs-source drift) — those keep
    historical "Amlak" mentions; and CLAUDE.md (this file — internal notes, now public; George may want it
    trimmed/removed). No behavior change; suite **161/161**. The DEMO sandbox was rebuilt + redeployed with
    the new name (Cloudflare `amlak-demo`, version `6d876f32`) — verified live: wordmark wraps cleanly to two
    lines, nav reads "Ask AI", zero console errors. The **live `amlak` app was NOT redeployed** (still shows
    "Amlak"); redeploy it if the production app should rebrand too — but that also rebrands tenant-facing
    invoice/email copy, so confirm with George first.
  - **GitHub:** `gh repo rename lease-extractor-v2` (auto-updated the local `origin` remote) + `gh repo edit
    --visibility public`. The Cloudflare **demo worker name is still `amlak-demo`** (renaming a worker changes
    its URL, which would break the link already shared — left as-is deliberately).

- **2026-07-07** — **Standalone demo sandbox for a submission** (George is submitting Amlak and needed a
  shareable demo with fake data and no reviewer setup). Deployed a **separate** Cloudflare Worker
  **`amlak-demo`** at **https://amlak-demo.akkawigeo-5.workers.dev** (version id `ef551d7d`). **No money**
  (same free `*.workers.dev` subdomain, no domain bought; demo AI answers are canned so no API spend),
  **no real data exposed** (the bundle has no Supabase creds — verified it contains zero references to the
  live project ref `awgrjmbcghdjgnqeiqkt`), **no production DB writes**, no beta-account slot used. The live
  `amlak` worker (version `e580d0d3`) and its `./build` were untouched.
  - **What George chose (via questions):** standalone sandbox (not a real seeded account on the live app),
    **auto-enter** (no login — just share the URL), **built-in demo data** as-is.
  - **How it works:** the app already has a full DEMO path — empty Supabase creds flip `DEMO_MODE`
    (`src/lib/supabaseClient.js`) so everything runs on the in-memory mock (`src/lib/demo/mockClient.js`)
    seeded from `src/lib/demo/store.js` (Acme Holdings / Northwind Group, Maple Plaza & Oak Center, tenants
    with leases/escalations/invoices/AR/insurance/history). Demo auth auto-returns a session
    (`mockClient.js:245`), so the reviewer lands straight in a populated Overview; 2FA is skipped
    (`AuthContext.js:22`). The app **already ships** a "🧪 Demo mode — seeded sample data, no backend" banner
    + a "Reset demo data" button, so **no app-source changes were needed** — this was purely build + deploy.
  - **New files (committed):** `vite.demo.config.js` (reuses the base build but points `envDir` at an empty
    `./demo-env/` so Vite loads NO creds → deterministic DEMO_MODE — the `.env*` files are hook-protected and
    never touched), `wrangler.demo.jsonc` (the `amlak-demo` worker → `./build-demo`), `demo-env/.gitkeep`,
    and `/build-demo` added to `.gitignore`. Build: `npx vite build --config vite.demo.config.js --outDir
    build-demo`; deploy: `npx wrangler deploy -c wrangler.demo.jsonc`.
  - **Trade-offs (agreed):** sandbox resets each visit (a plus — always pristine, unbreakable); AI features
    return canned demo answers, not live AI. **To redeploy the demo** after future changes: rebuild with the
    command above, then `wrangler deploy -c wrangler.demo.jsonc`. **Verified:** demo URL 200s, auto-enters to
    a populated dashboard + Leases list, **zero console errors**; live app still 200s and still shows its real
    login; demo bundle confirmed free of the live backend ref.

- **2026-07-07** — **Comprehensive review + 6 fix groups** (George approved the full findings report —
  plan file `~/.claude/plans/you-are-doing-a-wobbly-steele.md` — then the fixes shipped one reviewable
  commit per group). Deployed: DB migrations `0055`+`0056` (Supabase `awgrjmbcghdjgnqeiqkt`), **8 edge
  functions** redeployed (shared anthropic.ts timeout) + **`query-portfolio` deleted** (dead, no live
  caller), frontend Cloudflare version `e580d0d3`. **No money, no tenant emails, no destructive data**
  (0055's dedupe-void step was verified a no-op on live — zero duplicate invoices existed; the
  index/view/policies are additive). Tests **161/161** (was 147 — new money suite). Commits `6e16b2d`,
  `fdc4bf8`, `7142b24`, `72c9c74`, `23b930d`, `4eb1936` (one per group — review each with `git show`).
  - **Group 1 — billing integrity (the two live-reproduced bugs).** (a) *Duplicate invoices*: nothing
    stopped a second "Save to receivables" (or the monthly tracker racing the invoice modal) from creating
    TWO live invoices for the same tenant+year — Outstanding AR doubled ($98,500→$208,300 in demo). `0055`
    voids any existing duplicates (live had none) + partial unique index `invoices(lease_id, year) where
    status<>'void'`; `ensureInvoice` treats the 23505 as "use the existing one"; new `upsertYearInvoice`
    refreshes-in-place (InvoiceButton badge now says *updated* vs *saved*). (b) *Penny leak*: $98,500/12 →
    $8,208.33×12 = $98,499.96, so a fully-paid year read "partial" with 4¢ owed forever.
    `monthlyScheduleForYear` is now penny-true (last owed month absorbs the rounding cents) and `0055`
    rebuilds `v_invoice_balances` with a ±5¢ dust clamp (drop+create — the live view predated
    `invoices.abatement_annual`, so REPLACE couldn't line up columns; grants + security_invoker
    re-established; the view now also exposes abatement_annual). Also: `markMonthPaid` is idempotent per
    month (double-click / two screens can't double-pay), bulk "✓ all" skips tenants whose year invoice is
    already settled (an annual lump payment no longer gets 12 extra charges), deleting a payment in
    Receivables refreshes the tracker/roll caches. **New `moneyCollection.test.js`** (13 tests): dedupe,
    exact 12-month reconciliation, bulk mark-all, AR aging, abatement credit line.
  - **Group 2 — alerts & freshness.** The overdue-invoice reminder (the one about money!) was the only
    alert with no ✉ — new `buildPaymentReminderEmail` letter wired through `draftAlertEmail` (the alert now
    carries balance + invoice year). Ask-Amlak cache fingerprint (v2) includes open balances, so recording
    a payment invalidates stale "who owes money?" answers. New `localDateIso()` — the browser's "today" is
    now the LOCAL calendar date, not UTC (after ~8pm Eastern the on-load engine could apply an escalation a
    day early; JS twin of `app_today()`/0051) — applied to the engine, renewal windows, reconcile, the
    once-a-day gate, and the portfolio snapshot. `promptDueRenewalDecisions` selects `LEASE_LIST_COLS`
    instead of `*` (stops downloading every lease's full text daily).
  - **Group 3 — security/config.** `0056`: `require_aal2` extended to the 4 tables 0052 missed
    (**`portfolio_qa_cache`** — cached answers naming tenants/balances were readable by a bare-password
    aal1 session — plus `user_preferences`, `user_security`, `email_2fa_codes`); and
    `apply_due_escalations()` notifications now carry `email_to`/`email_to_2` (the bell's send modal opened
    blank for cron-applied escalations). `config.toml` `[auth.mfa.totp]` flipped to true so a future config
    push can't silently disable 2FA.
  - **Group 4 — resilience.** `callClaude` attempts now run under `AbortSignal.timeout` (default 90s,
    caller-tunable); a hung connection gets ONE retry then a clear error. extract-lease's form calls run at
    40s so the whole function fits the 150s edge wall clock — a hung Anthropic call can no longer burn a
    paid extraction into an HTTP 546.
  - **Group 5 — hygiene.** Deleted dead code: `getCorpCounts`/`getCorpRollup`, the email-2FA client
    helpers (native TOTP replaced them; the dormant send/verify-2fa-code edge fns stay deployed),
    `query-portfolio` (source + deployed fn + demo route), `reportWebVitals.js` + `web-vitals` dep.
    `@testing-library/*` → devDependencies. README rewritten (was "PropManager"/CRA/3 migrations).
    `.page-head` actions wrap on phones instead of clipping. NOTE: `.env.production` still carries the dead
    CRA `GENERATE_SOURCEMAP` flag — the block-secrets hook protects that file; harmless (Vite ignores it),
    remove by hand whenever.
  - **Group 6 — accessibility.** New shared `useModalA11y` hook (Escape closes, focus moves in / traps /
    returns to the opener) wired into all 7 modals (now `role="dialog"`); Dashboard's clickable
    notification/alert bodies + expiring-lease rows are Enter/Space-activatable.
  - **Verified:** unit (161/161), `vite build`, and end-to-end in demo with a real browser — the exact
    dup-invoice repro now shows "✓ Receivables updated" with ONE invoice; 12 tracker clicks settle
    $98,500.00 to $0.00 / "paid"; the overdue alert's ✉ opens the full letter with the right figures;
    Escape closes modals. **Live DB verified:** unique index present, 4 aal2 policies present, rebuilt view
    serves 8 rows, zero duplicate invoices, zero dust balances. Live site 200s.
  - **Still open from the review (deliberately deferred):** **A-1** transactional RPC ports for
    confirmRenewal/applyAddendum/reconcile (the long-staged item — do next, now that the money tests
    exist); **S-2** storage-file cleanup on delete; **T-2** component/render tests; P-2/P-3 minor batching;
    the corp/property-card ARIA nesting nit.

- **2026-07-06** — Fix: **Overview "Annual rent roll" ≠ property-page revenue** for a renewed lease.
  Deployed: DB migration `0054` (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version
  `931cb67a`. **No money, no tenant emails**; migration is a non-destructive function replace, and the
  live-data repair is additive (2 ledger rows + one already-approved invoice correction).
  - **What George saw:** the Overview rent-roll card showed a different number than a property's revenue
    (Leases → property). Verified live: Pershing Plaza card **$302,537.36** vs Overview **$295,359.36** —
    a **$7,178** gap, entirely from **FIVE POINTS WINGS, LLC** (Wingstop).
  - **Root cause:** two sources. The property card sums raw `leases.base_rent`
    (`PropertiesPage.js:96`); the Overview + property Financials read `v_property_totals.total_revenue` =
    Σ SQL `effective_rent(lease, year)` (`0001_init.sql`). `effective_rent` ALWAYS preferred the latest
    APPLIED escalation over `base_rent`. Confirming a renewal (`rollLeaseIntoRenewal`, `api.js`) writes
    the new rent onto `base_rent` but **never recorded a matching applied escalation**, so Wingstop's
    ledger still ended at its 2017 step ($34,225) while `base_rent` was the renewed $41,403. Difference =
    41403 − 34225 = **7178**, exactly. (Only this one lease mismatched portfolio-wide.)
  - **Root fix — era-aware `effective_rent`** (`0054_effective_rent_era.sql`, non-destructive
    `create or replace`; both views pick it up unchanged): `base_rent` is the CURRENT rent (kept live by
    applyDueEscalations, renewals, manual edits), so it wins for the **current era**. The ledger is only
    consulted for a **historical year** — one that has an applied step dated AFTER it. For a healthy
    lease (ledger in sync) the output is IDENTICAL to before, so no other number shifts. Mirrored in the
    JS `effectiveRent` (`src/lib/escalations.js`, used only by the demo mock) for demo parity.
  - **Prevention** (`api.js` `rollLeaseIntoRenewal`, catch-up branch): after moving `base_rent`, it now
    inserts an **applied** escalation at the new term start with the renewal's rent (when the rent
    changed and no step already sits there), so the ledger stays in sync going forward. Written AFTER the
    lease update, so an interruption still leaves `base_rent` right and the era-aware function correct.
  - **Live-data repair** (via `supabase db query`): added Wingstop's two option-period rents to the
    ledger as applied steps — `2018-01-01 → 37,648` and `2023-01-01 → 41,403` — so PAST fiscal years read
    the rent that actually applied (2018-2022 → 37,648; 2023+ → 41,403). Corrected the 2026 invoice
    (`ffae6313…`, still `sent`) from the stale $34,225 base ($53,884.33 total) to $41,403
    (**$61,062.33** total; CAM/tax lines are SF-based, unchanged). January's recorded payment untouched —
    the shortfall now correctly shows as owed. Both guarded (idempotent).
  - Verified: new `src/lib/__tests__/effectiveRentEra.test.js` (6 tests — era-aware parity + the
    stale-ledger bug + post-repair history + scheduled-step-doesn't-shift + the renewal→ledger→rent-roll
    e2e). Full suite **147/147 green** (`vitest run`); `vite build` compiles. **Verified on LIVE data:**
    zero leases mismatch base_rent vs effective_rent(2026); Pershing `v_property_totals` 2026
    total_revenue = **$302,537.36** = the card sum; Wingstop year-by-year history correct. Committed only
    this task's files. (Renumbered my migration 0051→0054 — sibling sessions had shipped 0051-0053.)

- **2026-07-06** — **Build tooling: Create React App → Vite** (audit item L2). Deployed: frontend
  Cloudflare version `bbd6b928`, commit `958a3c2`. No DB, no edge functions, no money, no tenant emails.
  Purely under-the-hood — no user-visible change; faster builds.
  - **Why:** react-scripts (CRA) is EOL. Swapped to **Vite 7** (build/dev) + **Vitest 3** (tests).
  - **Config (`vite.config.js`):** esbuild `loader:'jsx', jsx:'automatic'` for `src/**.js` (the app keeps
    JSX in `.js` files and uses the automatic runtime — components don't `import React`); **`envPrefix:
    ['VITE_','REACT_APP_']`** so `.env.production`/`.env.local` and the live Supabase creds are untouched
    (`supabaseClient.js` now reads `import.meta.env.REACT_APP_*`); `build.outDir:'build'` so `wrangler.jsonc`
    (`assets.directory: ./build`) is unchanged; **`test.env`** forces the two Supabase vars empty so the
    suite stays in DEMO mode (Vite loads `.env.local` in test mode, unlike CRA).
  - **Files:** `public/index.html` → root `index.html` (drop `%PUBLIC_URL%`, add the `/src/index.js` module
    script); `package.json` scripts now `vite`/`vite build`/`vitest run` (react-scripts + the `react-app`
    eslintConfig removed); added `vite`/`@vitejs/plugin-react`/`vitest`/`jsdom` dev deps.
  - **Gotcha hit + fixed:** `vite@latest` (v8, Rolldown bundler) failed to parse JSX-in-`.js`; pinned to the
    proven **Vite 7 / plugin-react 4 / Vitest 3** stack where the esbuild jsx-loader recipe is stable.
  - Verified: **141/141** via `vitest run`; `vite build` compiles (782 modules); the built bundle embeds the
    live Supabase URL (NOT demo); and the built app boots in a real browser (login renders, **zero console
    errors**) before deploy. Committed only this task's files.

- **2026-07-06** — **Audit follow-through** (the held-back + open items George green-lit: real 2FA,
  atomic lease creation, overdue-invoice alerts, timezone pin, CORS lockdown, error surfacing).
  Deployed: DB migrations `0051`/`0052`/`0053` (Supabase `awgrjmbcghdjgnqeiqkt`), 12 edge functions
  redeployed (shared CORS change), `ALLOWED_ORIGINS` secret set, frontend Cloudflare version
  `d203539c`. Commit `ab55940`. **No money, no tenant emails, no destructive data** (migrations are
  additive: new fns/policies/column-free). Tests **141/141**.
  - **C2 (Critical) — real authenticator 2FA, server-enforced.** Replaced the client-only email-OTP
    (which a valid aal1 JWT bypassed via PostgREST) with Supabase **native TOTP MFA**: `SecuritySettings.js`
    enrolls via QR + verify; `TwoFactorChallenge.js` steps the session up to aal2; `AuthContext.js` gates on
    the real `getAuthenticatorAssuranceLevel()` (not a client flag). **Server enforcement** = `0052`:
    `user_has_verified_mfa()` (SECURITY DEFINER, reads `auth.mfa_factors`) + a `require_aal2` RESTRICTIVE
    RLS policy on **all 22 owner-scoped data tables** — `aal2 OR not user_has_verified_mfa()`. **Safe by
    construction:** dormant for any user with no verified factor (there are **0** now → zero impact on
    George today); it only bites after a user enrolls (which itself proves the code + elevates that session
    to aal2). service_role/anon unaffected → cron/edge keep working. Email-2FA (0030 tables, send/verify
    fns) left dormant (non-destructive). **George: enroll your authenticator in Settings → Security to turn
    it on; if you ever lose the device, I can reset it from the backend.**
  - **C3 (money path) — atomic lease creation.** `0053 create_lease_tx(jsonb…)` (SECURITY INVOKER, so RLS
    still applies) inserts a lease + its escalations/renewals/abatements in ONE transaction;
    `createLeaseFromExtraction` (`api.js`) now calls it via a new `callRpc` helper (owner_id forced
    server-side), and `mockClient.js` mirrors the RPC so demo + the replay tests exercise the same path. A
    failed import can no longer leave a half-built lease with missing rent steps. **Deliberately staged
    (NOT done — flagged):** the `confirmRenewal`/`applyAddendum`/`reconcileRenewalOptions` (H4) RPC ports —
    they're entangled read-modify-writes that already self-heal via `backfillLeaseToToday`, and hand-written
    heterogeneous money-SQL is untestable in Jest, so rushing it into this batch risked corrupting live
    lease/rent data. Recommend doing them as a focused, separately-verified step.
  - **4a — overdue-invoice alerts.** `buildAlerts` (`alerts.js`) + `fetchAlertData` (`api.js`) now surface
    any unpaid, past-due invoice (from `v_invoice_balances`, balance > 0) as a danger alert on the
    dashboard, always shown until paid (no 6-month horizon). Mock `QB` gained `.gt`/`.lt`.
  - **M1 — timezone.** `0051` adds `public.app_today()` (= Eastern date) and swaps `current_date` →
    `app_today()` in `apply_due_escalations`/`apply_due_renewals`/`regenerate_lease_reminders` (byte-identical
    otherwise). Behavior-neutral at the 13:00-UTC cron time (UTC date already == Eastern there); future-proofs
    off-hours/manual runs.
  - **M6 — CORS lockdown.** `_shared/cors.ts` now resolves the allowed origin **per request** via a
    `cors(req)` factory (reflects the request origin when it's the prod origin or any localhost; else the
    primary). Threaded through the 12 functions that import it (one destructure line each; no json() callsite
    churn). Backward-compatible standalone exports kept. `ALLOWED_ORIGINS` secret set; built-in default also
    hard-codes the prod origin so a deploy without the secret is still locked (not `*`).
  - **6-residual — error surfacing + lighter loads.** New shared `MutationError` component drops a friendly
    line when a save/delete fails, added to the money editors (CAM, building size, escalations, abatements,
    invoices+payments, renewals, service contracts) — no more silent failed clicks. `listLeases`/
    `listLeasesByProperties` now select an explicit `LEASE_LIST_COLS` (everything **except** the big
    `lease_text` blob) so property/tenant lists load lighter; `getLease` (detail page) keeps `select('*')`.
  - **Still open / not attempted:** the confirm/addendum/reconcile RPC ports (above); the **Vite** build swap
    (large + touches build+test tooling — being done as an isolated follow-up so its risk doesn't co-mingle
    with these security/data migrations).

- **2026-07-06** — Security/quality **audit fixes** (10 items from the read-only audit; the two
  biggest-risk architectural ones deliberately held back — see note). Deployed: DB migration `0050`
  (Supabase `awgrjmbcghdjgnqeiqkt`), 8 edge functions redeployed (shared retry), frontend Cloudflare
  version `1a5a716d`. **No money, no tenant emails, no destructive data** (migration is additive:
  new column + index + function replace + grant revokes).
  - **C1 (Critical) — tenant removal no longer destroys billing history.** Deleting a lease cascades to
    its invoices+payments (0023 `on delete cascade`), and `archiveLease` only copied summary fields — so
    an entire tenant's AR/payment ledger was lost for good, silently. `0050` adds `expired_leases.financials
    jsonb`; `archiveLease` (`api.js`) now snapshots `listInvoices`+`listPayments` into it BEFORE the delete
    (best-effort — a read hiccup never blocks removal). `RemoveTenantModal.js` copy updated.
  - **C3 partial (Critical vector) — `applyEscalation` reordered.** It marked the step `applied` THEN
    wrote `base_rent`; a tab death between the two left the step applied with a stale rent forever
    (`applyDueEscalations` skips applied rows). Now writes `base_rent` first → an interruption leaves it
    `scheduled` and re-appliable. (Full transactional RPC rewrite NOT done — held back.)
  - **H1 (High) — duplicate renewal prompts killed at the DB.** `0050` adds a partial unique index
    `(lease_id) where kind='renewal_decision'`, recreates `apply_due_renewals()` with `on conflict … do
    nothing`, and `promptDueRenewalDecisions` (`api.js`) swallows the 23505 race.
  - **H2 (High) — write-on-read gated.** `Layout.js` fired the escalation+prompt engine on EVERY load,
    duplicating the nightly cron; now gated to once/calendar-day/browser via localStorage in live mode
    (demo still runs each load).
  - **H3 (High) — AI extraction survives a load spike.** `_shared/anthropic.ts callClaude` retries
    transient 429/500/502/503/529 with backoff (≤3 tries). Redeployed the 8 functions that use it
    (extract-lease/-addendum/-contract/-insurance, ask-portfolio/-lease/-doc, trends-narrative).
  - **M4** — `ask-portfolio` appends a "summary truncated" note instead of silently dropping tenants.
    **M5** — `0050` revokes `anon`/`public` EXECUTE on `log_security_event` + `ai_rate_check` (audit
    spoofing; app calls them as service-role/authenticated, which keep working). **M3** — `App.css`
    `@media (max-width:768px)`: sidebar → 64px icon rail, rows stack. **L1** — removed the dead
    `currentRenewalId` archive branch in `backfillLeaseToToday`. **L3** — deleted leftover `vercel.json`.
  - **Held back on purpose (need a careful, tested rollout — flagged to George):** **C2** 2FA is a
    client-side UI gate only (a valid JWT bypasses it via PostgREST); the real fix is server-side
    enforcement/native MFA and a wrong RLS change could lock George out. **C3-full** RPC-transactionalize
    confirmRenewal/applyAddendum/createLeaseFromExtraction + **H4** port `reconcileRenewalOptions` to SQL
    (large money-path rewrite, needs tests). **M6** set `ALLOWED_ORIGIN` (would break local dev), **M1**
    timezone (local-vs-UTC decision touching the cron), **L2** CRA→Vite. Verified token-free: full suite
    **139/139 green**; `CI=true` build compiles (+82 B); migration verified live. Committed only this
    task's files.

- **2026-07-06** — Overview / property pages now count an **outdated ("needs extension") tenant as
  occupied**, matching the Leases page (fixes my earlier "Overview↔property sync", which synced them to
  each OTHER via `v_property_totals` instead of to the Leases page). Deployed: DB migration `0049`
  (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `a1e5d492`. No money, no tenant emails,
  no destructive data (non-destructive `create or replace view`).
  - **What George caught:** the Leases page sums EVERY lease's SF (`LeasesPage.js:34`, no `is_active`
    filter), so an expired-but-not-removed tenant (his beauty/barbershop) still counts as occupied and
    the bottom "Vacant space → Available" reads **882 SF**. But the Overview, property Financials page,
    and property cards read `v_property_totals`, whose `leased` CTE filtered `where is_active` — so that
    tenant's space showed as *vacant* and its rent dropped from the rent roll. George's rule: an
    outdated tenant counts **fully** (space + rent) until HE removes it; a lapsed date shouldn't auto-evict
    it from the numbers.
  - **Fix (migration `0049` recreates `v_property_totals`):** added an `occupied` CTE = **all** leases
    that now drives `total_sf` / `building_sf` fallback / `vacant_sf` / `occupancy`; dropped `and l.is_active`
    from `total_revenue`/`noi` so the outdated lease's rent counts (`effective_rent` falls back to
    `base_rent`); dropped the `periods` CTE's `is_active` filter. **Billing untouched** — the active-only
    `leased` CTE still feeds `resp_sf` + `tax_psf`/`cam_psf`/roof denominators, so the summary $/SF rate
    cards keep matching the per-tenant bills (`v_tenant_shares`, 0042). `DashboardPage.js` +
    `PropertyFinancialsPage.js` read the view → both fixed by the one migration, no frontend edits there.
  - **Frontend:** `PropertiesPage.js` property card now counts ALL leases for tenant count / SF /
    occupancy / revenue (dropped the `is_active !== false` filter). `mockClient.js propertyTotals` mirrors
    the SQL split (all leases for occupancy/revenue; active leased SF for the $/SF denominators).
  - Verified token-free: `contractCam.test.js` +2 (an outdated lease counts in total_sf/vacant/occupancy/
    revenue; with no building size, occupancy uses ALL leases but $/SF still divides by ACTIVE SF). Full
    suite **139/139 green**; `CI=true` build compiles (−16 B). **Verified on LIVE data** (read-only query):
    Pershing Plaza `v_property_totals` now reads total_sf **12,868** (was 11,791), vacant **882**, occupancy
    **93.6%** — exactly matching the Leases page (the 1,077-SF outdated tenant is now counted). Committed
    only this task's files.

- **2026-07-06** — Six-in-one round: notifications audit + repairs, Overview↔property number sync,
  insurance send-log, renewal timing verify + guard, rent-roll speed, and Receivables toggle reaching
  the Finances page. Deployed: DB migrations `0047`+`0048`, `send-reminders` edge function scheduled
  (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version `3409280c`. **No money, no tenant
  emails** (reminder emails go to the OWNER only), no destructive data.
  - **Item 5 — rent roll no longer slow.** The "✓ all" bulk mark was a sequential N+1 (per tenant:
    fetch invoice → list payments → full markMonthPaid, 60–100 queries). Rewrote `markMonthPaidAllTenants`
    (`api.js`) to reuse the roll the component already has, `Promise.all` the missing-invoice creates, and
    insert ALL payments in one batched `insert`. Added **optimistic updates** to `PropertyRentRoll.js` +
    `MonthlyRentTracker.js` (the click paints instantly, rolls back on error) and **scoped** the cache
    invalidations to the affected lease/property (was a blanket `['payments']`/`['invoices']` sweep that
    restaled the whole app). Added `onError` so failures show a message instead of silently doing nothing.
  - **Item 2 — Overview matches the property page.** The dashboard summed raw `base_rent` and computed
    its own occupancy; the property Financials page reads the year-aware `v_property_totals` view
    (escalated `effective_rent`, building-SF occupancy). `DashboardPage.js` now sums the SAME view
    (`listPropertyTotalsByYear`, keyed on the shared fiscal year) for rent roll / leased SF / occupancy /
    vacant SF. Property **cards** (`PropertiesPage.js`) now filter out inactive leases so their tenant
    count / SF / revenue align too. Demo mock (`mockClient.js`) view branch handles the `.in(ids)` rollup.
  - **Item 3 — insurance requests are logged.** "Request from tenant" (lease page) and the dashboard
    insurance-expiry ✉ now record a dated `insurance_requested` **history event** when sent
    (`EmailComposeModal`/`NotificationEmailModal` gained an `onSend` hook; `api.js`
    `logInsuranceRequest`/`listInsuranceRequests`). The tenant Insurance panel shows **"📨 Last requested
    {date}"** (with an honest "sent from Amlak — delivery isn't tracked" note); the property **History**
    page lists each request. Demo seeds one event. No migration (reuses `history_events`, 0035/0040).
  - **Item 1 — notifications inventoried + the nightly cron actually fixed.** Migration **0047** pins
    `search_path = public` on the three 0002 reminder trigger functions (the empty search_path under the
    SECURITY-DEFINER cron was crashing every night), adds the JS **term-end gate** to SQL
    `apply_due_escalations` (un-exercised option rents stay scheduled until the renewal is confirmed), and
    **schedules `send-reminders`** daily at 13:00 UTC (it was never scheduled — owner-only emails, first
    due 8/31). Running the job then surfaced a SECOND latent bug — `apply_due_renewals()`'s cleanup
    `delete … using public.leases l` collided with its own `l` record variable (`record "l" is not
    assigned yet`), so the renewals half never ran; migration **0048** renames that alias. **Verified
    live:** `apply_due_changes()` now runs clean (2 changes applied) and the stuck **Infinite Mobile
    2026-07-01 → $28,745.04** escalation is now `applied`. Also fixed `alerts.js`: a *declined* renewal
    option no longer mutes the red "lease ending — no renewal" warning (only pending/applied soften it).
  - **Item 4 — renewals already behave correctly (verify-only) + a guard.** Confirmed: clicking Renew on
    a FUTURE option only extends the end date and lays the new rent in as dated steps — today's rent and
    `lease_start` are untouched until each step's date arrives. Added a guard so confirming a renewal on a
    lease with **no term-end date** refuses with a friendly message (was silently nulling the lease dates):
    `confirmRenewal` returns `{ needsTermEnd }`, surfaced in `RenewalOptionsEditor.js` + the dashboard bell.
  - **Item 6 — hiding Receivables now also hides it on Finances.** `PropertyFinancialsPage.js` gates
    `ARSummary` behind the same `ar` Display toggle (was unconditional); updated the toggle's hint.
  - Verified token-free: `sixMonthAlerts.test.js` +1 (declined vs pending renewal → red vs softened
    lease-ending alert), `futureRenewalConfirm.test.js` +1 (no-term-end lease refuses renewal, changes
    nothing). Full suite **137/137 green**; `CI=true` build compiles (+1.56 kB). Committed only this
    task's files. **George — two follow-ups on the email cron:** (1) the daily `send-reminders` emails
    only YOU (never tenants) about due lease/insurance dates; (2) for those emails to actually send it
    needs `REMINDER_FROM_EMAIL` (set to `onboarding@resend.dev` until a domain is verified) + `CRON_SECRET`
    set as edge-function secrets — until then it still creates the in-app reminders, just no email.

- **2026-07-06** — Removed the lease-search box; built **"Ask Amlak"** — a sidebar page that answers
  natural-language questions about the account's OWN records (tenants, insurance, contracts, rent,
  who owes money). Deployed: DB migration `0046` (drops `lease_qa_cache`, adds `portfolio_qa_cache`;
  Supabase `awgrjmbcghdjgnqeiqkt`), new `ask-portfolio` edge function, frontend Cloudflare version
  `d5e81cf2`. **Costs money** (George approved): a fresh question is **well under ½¢**; repeats on an
  unchanged portfolio are **$0** (cached); nothing runs without a click → a month is cents.
  - **What George asked:** he did NOT want the earlier AI feature that read lease *documents*
    ("nah i dont like that … i meant being able to read the website not the leases"). He wants to
    ask the app about its **records** — e.g. "which tenants have an insurance contract saved and
    which don't?", "who owes money?" — and click through to the tenant. He also said to **take out
    the whole lease-search box** and **drop** its cache table.
  - **Part 1 — removal.** Deleted `src/components/LeaseSearch.js` + the `ask-leases` edge function;
    stripped `src/lib/leaseSearch.js` to just `byTermEnd` (the soonest-expiring tenant sort, a
    SEPARATE feature — kept); removed `askLeasesQuestion`/`COMMON_QUESTION_TERMS`/cache
    helpers/`listAddendumsByLeases` from `api.js`, the search box from `LeasesPage.js`, the
    `ask-leases` demo route, and the `.lease-search*`/`.ai-answer*`/`.chip` CSS. Migration `0046`
    `drop table if exists lease_qa_cache` (George OK'd — it only held regenerable cached answers).
  - **Part 2 — Ask Amlak (cheap, facts-only).** The app assembles a compact **summary** of the
    portfolio (per property → each tenant's insurance-on-file + expiry, rent, lease dates, renewal
    option, balance owed; landlord insurance; service contracts) — **no documents**, a few KB — and a
    small model (Haiku 4.5) answers over it. Sub-cent per question; cached per user keyed by a
    portfolio **fingerprint** (`snapshotFingerprint` = row counts + latest `updated_at`) that flips
    on any lease/insurance/contract change, so repeats are $0 and stale answers never match. Pieces:
    new pure `src/lib/portfolio.js` (`buildPortfolioSnapshot` + `snapshotToText` + `snapshotFingerprint`
    + `normalizeQuestion`); `api.js` `fetchPortfolioSnapshot`/`askPortfolioQuestion` + cache helpers;
    `supabase/functions/ask-portfolio` (owner-scoped, rate-limited, summary in a `cache_control` block,
    answer-only/no-arithmetic); new `src/pages/AskPage.js` (question box + suggested chips + Q&A log +
    **"· saved answer (free)"** tag + **Open:** click-through links to each tenant/property named in an
    answer); route `/ask` + a **Ask Amlak** sidebar item (reused `SparkIcon`); `.ask-*` CSS. Demo:
    `demoAskPortfolio` answers from the seeded data so demo never calls out.
  - Verified token-free: new `src/lib/__tests__/portfolio.test.js` (insurance-on-file flag incl.
    archived-ignored; renewal option; balance owed w/ draft excluded; soonest-end sort + click-through
    ids; expiry flips; inactive-lease exclusion; `snapshotToText` facts; fingerprint stable/flips;
    `normalizeQuestion`); `leaseSearch.test.js` trimmed to `byTermEnd`. Full suite **135/135 green**;
    `CI=true` build compiles (−214 B — the removal outweighed the new page). Migration pushed (only
    0046 pending), edge fn deployed clean (Deno bundled the shared modules). **UI-verified inline in
    demo:** the "no insurance" chip → "Tenants with NO insurance on file (2): City Dental — Maple
    Plaza · Northwind Books — Oak Center" with working **Open:** links (clicking City Dental opened its
    lease); the Leases page no longer shows a search box and still sorts tenants soonest-first; zero
    console errors. Committed only this task's files.
  - **Live check:** open **Ask Amlak** in the sidebar → tap "Which tenants have no insurance on file?"
    (or type any question) → named answer + **Open:** links; ask again → instant "saved answer" with no
    second model call. ~½¢ first time, $0 repeats.

- **2026-07-06** — Hybrid AI lease answers: the free keyword search now has an optional "🤖 Answer
  this across these leases" that reads ONLY the matched clauses and answers by tenant (e.g. "who
  pays for the roof?"). Built for cost: three levers stacked. Deployed: DB migration `0045`,
  `ask-leases` edge function (Supabase `awgrjmbcghdjgnqeiqkt`), frontend Cloudflare version
  `db33f513`. **Costs money** (George approved): a fresh question is **under ½¢**; repeats /
  unchanged corpus are **$0**; common questions warm once. A normal month → well under $1.
  - **What George asked:** make the earlier free search *answer* the question, but as cheaply as
    possible without hurting quality. His insight (correct): don't re-read every lease's full text
    per question — let the keyword search narrow it, then send the AI only the matched clauses. He
    chose to **stack all three** cost levers.
  - **Lever 1 — send less** (`src/lib/leaseSearch.js` new pure `gatherAnswerContext`): for each
    lease that matches the term, widen each hit to its whole clause/paragraph (~600–900 chars,
    deduped, capped per lease), labeled by tenant — the AI's evidence, far richer than the 60-char
    display snippet, but a tiny fraction of the full library. Recall safety net: if the property's
    whole corpus is small (≲ ~30k tokens, e.g. Harlem), send each matched lease's FULL text instead
    (perfect coverage, still ~3¢). ~½¢ vs ~8¢ full-corpus at Pershing, and **flat as the library
    grows** (unmatched leases are never sent).
  - **Lever 2 — answer once, reuse free** (migration `0045_lease_qa_cache.sql` + `api.js`
    `askLeasesQuestion`): every answer is cached per property, keyed by a **corpus fingerprint**
    (`leaseCorpusFingerprint` — max lease/rider `updated_at` + text lengths). Re-asking the same
    thing on an unchanged corpus returns the stored answer for **$0** and never calls the model; any
    lease edit/add/remove flips the fingerprint so stale answers stop matching. New owner-scoped
    `lease_qa_cache` table (RLS mirrors `user_preferences`/0038; additive, non-destructive). Cache
    read misses degrade gracefully (feature still works if the table is absent); writes are
    best-effort.
  - **Lever 3 — warm the common questions** (`precomputeCommonQuestions` + `COMMON_QUESTION_TERMS`
    = roof/HVAC/property taxes/CAM/insurance/structural): a row of **common-question chips** under
    the search box; clicking one fills the search and answers it (cached after, so free next time).
    **Implementation choice:** warming is done as a property-level cache — *not* by editing the
    at-ceiling `extract-lease` import path (one field from the 16-union limit, and heavily touched
    by other sessions). And warming is **never auto-fired** on page load (George is money-sensitive)
    — it happens only on an explicit chip/button click. `precomputeCommonQuestions` exists (exported)
    for a future bulk/automated warm but isn't wired to auto-run.
  - **The keyword-vs-question gotcha (caught in planning):** the free search requires EVERY word to
    appear in the lease, so a natural-English question ("who pays the roof?") would match nothing.
    So the AI is keyed off the **search TERM** ("roof"); `buildLeaseQuestion(term)` templates the
    per-tenant tenant-vs-landlord question around it, and the cache key is the normalized term.
  - **Edge function `ask-leases`** (clone of `ask-lease`, array input): owner-scoped,
    `enforceRateLimit`, Haiku 4.5, excerpts in a `cache_control` block (prompt caching for bursts),
    tight `max_tokens`, group-by-tenant + quote-the-clause + no-arithmetic instruction, 40k-char
    input backstop. Stateless — caching lives client-side. `ask-lease` (single-lease Q&A) untouched.
  - **UI** (`LeaseSearch.js` + `App.css`): the answer panel renders **above** the snippet rows (which
    stay as the visible evidence), with a "· saved answer (free)" tag on a cache hit and a "confirm
    against the lease" footnote. Demo mode (`mockClient.js` `demoAskLeases`) returns a canned grouped
    answer so demo never calls out.
  - Verified token-free: `src/lib/__tests__/leaseSearch.test.js` +11 (normalizeQuestion;
    buildLeaseQuestion; leaseCorpusFingerprint stable/flips on text|updated_at|rider change;
    gatherAnswerContext matched-only + whole-clause widening + per-lease cap + small-corpus full-text
    + rider label). Full suite **142/142 green**; `CI=true` build compiles (+1.91 kB). Migration
    pushed (only 0045 pending), edge fn deployed clean (Deno bundled the shared modules). **UI-verified
    inline in demo:** the roof chip → grouped answer "City Dental: Landlord responsible … Bright
    Coffee: Tenant responsible …" with highlighted clauses below and tenants still sorted soonest
    first. Committed only this task's files.
  - **Live check:** open a property → Leases → type "roof" (or click the roof chip) → "🤖 Answer" →
    grouped who-pays-what with clauses; ask again → instant "saved answer" with no second Haiku call
    (edge logs). ~½¢ first time, $0 repeats.

- **2026-07-06** — Per-property lease search (free, no AI) + tenants sorted soonest-expiring
  first. Deployed: frontend Cloudflare version `78fe1932`. No migration, no edge functions,
  **$0 per search** — no AI call anywhere.
  - **What George asked:** a search bar inside a property that reads through the cached leases
    (e.g. "which of my tenants must pay for the roof?"), preferably without AI calls and without
    a canned list of preloaded questions; plus the tenant list ordered by soonest term end.
  - **Search (new `src/lib/leaseSearch.js` + `src/components/LeaseSearch.js`, wired into
    `LeasesPage.js`):** a pure in-browser keyword scan of the text already cached at import —
    `leases.lease_text` (ships with `listLeases`'s `select('*')`, no new fetch) plus every
    rider's `addendum_text` (new `listAddendumsByLeases` in api.js — one batched query, loaded
    lazily only when a search starts). Free text, any words: every word must appear in the
    tenant name / lease / riders; a match shows up to 3 highlighted clause snippets (60 chars
    of context, rider label when the hit came from an amendment) so George judges "Tenant shall
    repair the roof" vs "Landlord shall…" himself in seconds. Leases with no document on file
    are listed as unsearchable with a nudge to upload/paste one. Clicking a hit opens the lease.
  - **Not built (George picked "cheapest meaningful version"):** an "Ask AI" layer. If snippets
    ever prove insufficient, one Haiku call over all cached texts per property (patterned on
    `ask-lease`) would run ~3¢/question at Harlem Plaza, ~8–10¢ at Pershing (~1–2¢ repeats
    within 5 min via prompt caching). Also noted: the structured `roof_responsible` column can't
    answer the roof question — the extractor never fills it (manual toggle, set on 1 of 12 live
    leases); the text search is the reliable path.
  - **Sort (`api.js` `listLeases` + `listLeasesByProperties`):** new `byTermEnd` comparator —
    soonest `lease_termination_date` first, no-end-date leases last, ties alphabetical — applied
    in JS after fetch so live and demo behave identically. Flows everywhere those helpers feed:
    the property's Tenants list, property-card tenant lists, and the rent-roll Excel export.
  - Verified token-free: new `src/lib/__tests__/leaseSearch.test.js` (9 tests — dated order /
    nulls last / ties; roof-clause snippet; case-insensitive; multi-word AND; tenant-name hit;
    rider hit carries its label; snippet cap vs full count; empty query). Full suite **131/131
    green**; `CI=true` build compiles. UI-verified inline in demo mode: City Dental (May 2026)
    now lists above Bright Coffee (Dec 2027); typing "roof" surfaced "Landlord maintains the
    roof" (City Dental) vs "Tenant is responsible for its pro-rata share of roof expenses"
    (Bright Coffee) with highlights; clicking a hit opened the lease. Committed only this
    task's files.

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
