import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getStatementMatchContext,
  listReconciliations,
  listSnapshots,
  applyStatementImport,
  suggestExpenseBuckets,
  suggestTenantMatches,
  saveExpenseBucket,
} from '../lib/api';
import { defaultCategoryFor } from '../lib/expenseCategories';
import TaxCategorySelect from './TaxCategorySelect';
import { incomeCategoriesInUse, incomeCategoryLabel, customCategoryKey } from '../lib/otherIncome';
import {
  matchStatement, suggestRulePattern, screenRulePatterns, depositProjectionDelta,
  corroborateAmount, monthOfDate, deriveEstimateFromDeposit, CAM_KEYWORD_LABELS,
} from '../lib/statementMatch';
import { buildMonthGroups } from '../lib/statementMonths';
import { dispositionForRow, lineCompleteness, completenessSentence, IGNORE_REASONS } from '../lib/dispositions';
import { buildPaymentShortfallEmail } from '../lib/emailTemplates';
import { DEMO_MODE } from '../lib/supabaseClient';
import { money, money0, money4, fmtDate } from '../lib/format';
import EmailComposeModal from './EmailComposeModal';
import MutationError from './MutationError';

// The full-page statement review — a 40–100-line table doesn't belong in a modal.
// Every line the parser produced is here in one of three groups (Money in ·
// Money out · Duplicates & skipped), each with the matcher's SUGGESTION as an
// editable pick. Nothing writes until Save; the footer summarizes exactly what
// will be recorded first. The property the EXPENSES land on is stated plainly up
// top (deposits self-route to their tenant's own property regardless), with a
// switch banner when the deposits vote for a different property.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const KIND_LABEL = { tenant: 'Tenant payment', expense_tax: 'Property taxes', expense_cam: 'CAM expense', expense_other: 'Other — not billed', expense_roof: 'Roof expense', ignore: 'Ignore', unmatched: '— pick —', owner_draw: 'Owner distribution', transfer: 'Transfer', other_income: 'Other income', deposit_held: 'Security deposit' };

const CONF_TONE = { rule: 'good', high: 'good', medium: 'warn', low: 'warn', none: 'info', ai: 'info' };
const CONF_LABEL = { rule: 'rule', high: 'confident', medium: 'likely', low: 'weak', none: '?', ai: 'AI' };

// Names in prose, capped so a property full of gross tenants can't run the line long
// (the alerts feed's three-then-"and N more" convention).
function listNames(names, max = 3) {
  if (names.length > max) return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

export default function StatementReview({ propertyId, year, fileName, accountHint, parsed, storagePath = null, pdfLane = false, onCancel, onSaved }) {
  // isError is read deliberately: without it a failed context load left the screen
  // on "Reading the statement…" forever, which reads as a hung AI even though the
  // transcript is already in hand. A failure must say so and offer a way out.
  const qc = useQueryClient();
  const { data: ctx, isError: ctxFailed, error: ctxError, refetch: retryCtx } = useQuery({
    queryKey: ['statementContext', propertyId, year],
    queryFn: () => getStatementMatchContext(propertyId, year),
  });

  // Which property the statement's EXPENSES record on. Defaults to the account's
  // last-used property (the ••4821 memory) when known, else the page's.
  const [expensePropPick, setExpensePropPick] = useState(null);
  const remembered = accountHint && ctx?.accountMemory?.[accountHint]?.property_id;
  const expenseProp = expensePropPick || remembered || propertyId;
  const { data: recons = [] } = useQuery({
    queryKey: ['reconciliations', expenseProp, year],
    queryFn: () => listReconciliations(expenseProp, year),
  });
  const { data: snapshots = [] } = useQuery({
    queryKey: ['snapshots', expenseProp],
    queryFn: () => listSnapshots(expenseProp),
  });
  const closedYears = useMemo(() => new Set((snapshots || []).map((s) => Number(s.year))), [snapshots]);

  // Per-row user overrides, keyed by row index: { checked, pick, month, always, ai }.
  // `pick` = 'lease:{id}' | 'cam:{bucket}' | 'other:{bucket}' | 'expense_tax' |
  // 'expense_cam' | 'expense_roof' | 'ignore'.
  const [overrides, setOverrides] = useState({});
  const setOv = (i, patch) => setOverrides((o) => ({ ...o, [i]: { ...o[i], ...patch } }));
  // Buckets created in THIS review session ("＋ New bucket…") — offered to every row.
  const [sessionBuckets, setSessionBuckets] = useState([]);
  // A drafted "your payment came in short of the scheduled rent" letter, opened in the
  // compose modal (nothing auto-sends — the landlord sends it, or closes it).
  const [letterDraft, setLetterDraft] = useState(null);
  // Per-lease tick for the CAM & tax estimates read from this statement: undefined =
  // the smart default (pre-ticked when the tenant has no estimate yet, unticked when it
  // would CHANGE one), true/false = the landlord's explicit choice.
  const [estOverrides, setEstOverrides] = useState({});

  // The payee a line will be remembered by. Bound to THIS statement's other descriptions,
  // because the rail is what the lines have in common and the payee is what only one line
  // says — a bank whose wording the stopword list doesn't know is caught by that alone.
  // Every caller on this screen goes through it, so the "remembers X" hint on a row and
  // the rule Save actually writes can never name two different things.
  const payeeOf = useMemo(() => {
    const descs = (parsed.transactions || []).map((t) => t.description);
    return (d) => suggestRulePattern(d, descs);
  }, [parsed.transactions]);

  // Draft rules from this session's "always" ticks re-apply to the OTHER lines of
  // this same import immediately (a garbled payee fixed once fixes the whole file).
  const draftRules = useMemo(() => {
    const out = [];
    for (const [i, ov] of Object.entries(overrides)) {
      if (!ov?.always) continue;
      const txn = parsed.transactions[Number(i)];
      if (!txn) continue;
      const pattern = payeeOf(txn.description);
      const resolved = resolvePick(ov.pick);
      // Stamp the statement's account hint so a same-session "always" fix outranks a
      // saved rule from a different account in the matcher's hint-preferred pass.
      if (pattern && resolved) out.push({ pattern, target_kind: resolved.kind, lease_id: resolved.lease_id || null, cam_label: resolved.label || null, property_id: expenseProp, account_hint: accountHint || null });
    }
    return out;
  }, [overrides, parsed.transactions, expenseProp, accountHint, payeeOf]);

  const matched = useMemo(() => {
    if (!ctx) return null;
    return matchStatement({
      transactions: parsed.transactions,
      propertyId: expenseProp,
      tenants: ctx.tenants,
      rules: [...draftRules, ...ctx.rules],
      existingHashes: ctx.existingHashes,
      accountHint,
    });
  }, [ctx, parsed.transactions, expenseProp, draftRules, accountHint]);

  // One resolved decision per row: what Save would actually write.
  const resolved = useMemo(() => {
    if (!matched) return [];
    const list = matched.rows.map((row, i) => {
      const ov = overrides[i] || {};
      const pick = ov.pick != null ? resolvePick(ov.pick) : null;
      const kind = pick ? pick.kind : row.kind === 'unmatched' ? 'ignore' : row.kind;
      const label = pick ? pick.label || null : row.label || null;
      const leaseId = pick ? pick.lease_id : row.candidate?.lease_id || null;
      const tenant = leaseId ? ctx.tenants.find((t) => t.lease_id === leaseId) : null;
      // Slice 4c — the income category, carried through from the pick.
      const category = pick ? pick.category || null : null;
      // Recompute recon routing when the user re-picked the tenant by hand. Only ever
      // for RENT: a deposit or a late fee names a tenant without paying an invoice, so
      // routing one to an open reconciliation would settle a bill it never paid.
      const toRecon = kind !== 'tenant' ? false
        : !pick ? !!row.candidate?.toRecon
        : !!(tenant?.reconBalance > 0 && Math.abs(tenant.reconBalance - row.txn.amount) <= Math.max(1, 0.01 * tenant.reconBalance));
      // Re-date on re-pick. row.month was computed against whoever the MATCHER named;
      // once the landlord names a different tenant that answer is about someone else,
      // and inheriting it is how a hand-corrected line saved with no month at all.
      // Only when they haven't chosen a month themselves — their pick always wins.
      const autoMonth = pick && kind === 'tenant' && tenant
        ? corroborateAmount(row.txn.amount, tenant, monthOfDate(row.txn.date)).month
        : row.month;
      const month = ov.month !== undefined ? (ov.month === '' ? null : Number(ov.month)) : autoMonth;
      // A month tag means "this settles that month's rent". Income and deposits settle
      // no month by definition, so they never carry one — which is also what keeps
      // them out of the estimate-derivation and the ledger's coverage arithmetic.
      const finalMonth = (toRecon || kind === 'other_income' || kind === 'deposit_held') ? null : month;
      const defaultChecked = row.checked && !row.txn.needsReview;
      const checked = ov.checked !== undefined ? ov.checked : defaultChecked;
      // An ignored/unresolved line writes nothing, whatever the checkbox says.
      // A row is writable when ticking it would actually record something. A transfer
      // writes nothing at all (its disposition IS the record), so it is deliberately not
      // writable and needs no tick. Other income always writes a row; a deposit writes no
      // row but DOES record which lease it belongs to, so it needs a tenant to be worth
      // ticking. An owner distribution writes a not-billed expense line, exactly as the
      // expense kinds do — which is why it sits on the same branch as them now.
      const writable = kind === 'tenant'
        ? !!(leaseId && tenant)
        : kind === 'other_income' ? true
        : kind === 'deposit_held' ? !!(leaseId && tenant)
        : kind === 'owner_draw' || kind.startsWith('expense_');
      // Does the deposit match what the ledger projects for the month it's applied to?
      // Only for a tenant payment tagged to a specific month; true-ups/lumps are excluded
      // by construction. Tolerance is amountMatches, so a "confident" row never flags.
      const mismatch = kind === 'tenant' && tenant && finalMonth ? depositProjectionDelta(row.txn.amount, tenant, finalMonth) : null;
      // Exact already-paid test, at the row level: is the month this line would settle
      // ALREADY covered on the ledger? (The matcher's coarse `collision` only fires on a
      // fully-covered tenant, and never at all on a remembered payee.) Back-filling old
      // statements onto months marked by hand is precisely how rent gets recorded twice.
      const alreadyPaid = !!(kind === 'tenant' && tenant && finalMonth && !toRecon
        && Number((tenant.owed || [])[finalMonth - 1]) > 0
        && Number((tenant.coverage || [])[finalMonth - 1]) >= Number(tenant.owed[finalMonth - 1]) - 0.05);
      const isChecked = writable && checked && !(alreadyPaid && ov.checked === undefined);
      return {
        row, i, kind, label, category, leaseId, tenant, toRecon, month: finalMonth,
        checked: isChecked,
        // WHO a distribution went to — typed on the row when the bank named a payee. A
        // cheque never does (the machine-readable line is number, date, ref, amount; the
        // name is handwriting on the image), so this is usually blank and the BUCKET
        // ends up named after the payee instead, which is where it is edited afterwards.
        party: ov.party || '',
        ai: !!ov.ai, picked: ov.pick != null,
        monthPicked: ov.month !== undefined, mismatch, alreadyPaid,
        // Slice 4a — what Save will record about this line in the audit table, whether
        // or not it writes any money. Derived here so the footer's counts and the row
        // itself can never disagree with what actually gets stored.
        disposition: dispositionForRow({ checked: isChecked, kind, picked: ov.pick != null, duplicate: row.duplicate }),
        ignoreReason: ov.reason || (row.duplicate ? 'duplicate' : null),
      };
    });
    // ⚠ TWO LINES ON ONE STATEMENT FOR ONE TENANT-MONTH — the case George named: *"sometimes
    // tenants pay twice in the same month."* `alreadyPaid` above only catches a month the
    // LEDGER already shows covered, so two deposits on the SAME statement for a month with
    // nothing recorded yet sail through unwarned and settle it twice over. A second pass here
    // rather than a prop threaded through Group → ReviewRow: the flag belongs to the row, and
    // every surface that reads a row gets it without being told to.
    const perMonth = new Map();
    for (const r of list) {
      if (r.kind !== 'tenant' || !r.tenant || !r.month || r.toRecon || !r.checked) continue;
      const k = `${r.tenant.lease_id}:${r.month}`;
      perMonth.set(k, (perMonth.get(k) || 0) + 1);
    }
    for (const r of list) {
      r.doubled = !!(r.kind === 'tenant' && r.tenant && r.month && !r.toRecon && r.checked
        && (perMonth.get(`${r.tenant.lease_id}:${r.month}`) || 0) > 1);
    }
    return list;
  }, [matched, overrides, ctx]);

  // The completeness tie-out, live as the landlord works: every transcribed line has a
  // decision, or it is counted as unplaced. Money in and money out stay separate — a
  // single netted figure would let an unplaced $5,000 deposit and an unplaced $5,000
  // withdrawal report "$0 unplaced", which is exactly the silent loss this ends.
  const completeness = useMemo(() => lineCompleteness(resolved.map((r) => ({
    disposition: r.disposition, amount: r.row.txn.amount, direction: r.row.txn.direction,
  }))), [resolved]);

  // Every bucket the dropdowns offer: the owner's saved buckets + the keyword
  // table's built-ins + any created in this session. First writer wins per name.
  const bucketOptions = useMemo(() => {
    const map = new Map();
    const add = (label, billable) => {
      const clean = String(label || '').trim();
      if (clean && !map.has(clean.toLowerCase())) map.set(clean.toLowerCase(), { label: clean, billable });
    };
    for (const b of sessionBuckets) add(b.label, b.billable);
    for (const b of ctx?.buckets || []) add(b.label, b.billable !== false);
    for (const l of CAM_KEYWORD_LABELS) add(l, true);
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [ctx, sessionBuckets]);
  // A new bucket is offered to every row in THIS session, and its tax category is
  // persisted straight away (0075). Saving it here rather than at import time is
  // deliberate: a category is vocabulary, not money — it moves no figure and bills
  // nothing — so the worst a cancelled review leaves behind is a named bucket with no
  // lines in it, which is exactly what naming a bucket meant. Best-effort: failing to
  // record the category must never block the import itself.
  const addSessionBucket = (label, billable, category) => {
    setSessionBuckets((s) => (
      s.some((b) => b.label.toLowerCase() === label.toLowerCase())
        ? s
        : [...s, { label, billable, category: category || null }]
    ));
    saveExpenseBucket({ label, billable, category: category || null })
      .then(() => qc.invalidateQueries({ queryKey: ['expenseBuckets'] }))
      .catch(() => { /* the bucket still works this session; the category can be set on Financials */ });
  };

  // 🤖 Suggest buckets — click-gated (~1–2¢), only for the money-out lines nothing
  // recognized. Suggestion-only: picks are set with an "AI" chip but stay UNCHECKED,
  // so nothing books without the user's tick (same rule as unknown money-out).
  // aiOp names WHICH helper is running ('tenants' | 'buckets' | null) — a shared
  // boolean made both buttons read "Suggesting…" at once, which looked like two
  // things had started when only one had.
  const [aiOp, setAiOp] = useState(null);
  const [aiErr, setAiErr] = useState('');
  const unrecognized = useMemo(
    () => resolved.filter((r) => r.row.txn.direction === 'out' && !r.row.duplicate && !overrides[r.i]?.pick && r.row.kind === 'ignore' && r.row.confidence === 'none'),
    [resolved, overrides]
  );
  async function suggestBuckets() {
    setAiErr('');
    setAiOp('buckets');
    try {
      const res = await suggestExpenseBuckets({
        lines: unrecognized.map((r) => ({ index: r.i, description: r.row.txn.description, amount: r.row.txn.amount })),
        buckets: bucketOptions.map((b) => b.label),
      });
      const adds = [];
      const patch = {};
      for (const s of res?.suggestions || []) {
        const target = unrecognized.find((r) => r.i === Number(s.index));
        const label = String(s.bucket || '').trim();
        if (!target || !label) continue;
        const billable = s.billable !== false;
        if (!bucketOptions.some((b) => b.label.toLowerCase() === label.toLowerCase())) adds.push({ label, billable });
        patch[target.i] = { ...overrides[target.i], pick: billable ? `cam:${label}` : `other:${label}`, ai: true };
      }
      if (adds.length) setSessionBuckets((s) => [...s, ...adds]);
      setOverrides((o) => ({ ...o, ...patch }));
    } catch (e) {
      setAiErr(e?.message || 'Could not get suggestions — sort the lines by hand instead.');
    } finally {
      setAiOp(null);
    }
  }

  // 🤖 Suggest tenants — the deposit twin of Suggest buckets. Every money-IN line the
  // matcher couldn't settle confidently, not just the ones it scored zero on: a bank
  // that abbreviates "Five Points Wings, LLC" to "Five Points Wing" lands a weak/likely
  // guess, and that guess is exactly the one worth an AI read. Name-matching only;
  // suggestions land UNCHECKED with the AI chip.
  const unmatchedDeposits = useMemo(
    () => resolved.filter((r) => r.row.txn.direction === 'in' && !r.row.duplicate && !overrides[r.i]?.pick
      && r.row.confidence !== 'high' && r.row.confidence !== 'rule'),
    [resolved, overrides]
  );
  // Rows carrying an AI suggestion that hasn't been accepted yet — "✓ Accept N AI
  // matches" is the bulk tick, so a 20-line statement isn't 20 clicks.
  const aiPending = useMemo(() => resolved.filter((r) => r.ai && !r.checked && !r.row.duplicate), [resolved]);
  const acceptAllAi = () => {
    const patch = {};
    aiPending.forEach((r) => { patch[r.i] = { ...overrides[r.i], checked: true }; });
    setOverrides((o) => ({ ...o, ...patch }));
  };
  async function suggestTenants() {
    setAiErr('');
    setAiOp('tenants');
    try {
      const res = await suggestTenantMatches({
        lines: unmatchedDeposits.map((r) => ({ index: r.i, description: r.row.txn.description, amount: r.row.txn.amount })),
        tenants: ctx.tenants.map((t) => ({ lease_id: t.lease_id, tenant_name: t.tenant_name, property_name: t.property_name, monthly: t.monthly })),
      });
      const validIds = new Set(ctx.tenants.map((t) => t.lease_id));
      const patch = {};
      for (const s of res?.suggestions || []) {
        const target = unmatchedDeposits.find((r) => r.i === Number(s.index));
        const leaseId = String(s.lease_id || '');
        if (!target || !leaseId || !validIds.has(leaseId)) continue; // guard hallucinated ids
        patch[target.i] = { ...overrides[target.i], pick: `lease:${leaseId}`, ai: true }; // UNCHECKED — needs the user's tick
      }
      setOverrides((o) => ({ ...o, ...patch }));
    } catch (e) {
      setAiErr(e?.message || 'Could not suggest tenants — pick them by hand instead.');
    } finally {
      setAiOp(null);
    }
  }

  // Learn payee → target rules so the NEXT statement auto-classifies without asking.
  // EVERY checked line teaches its payee — a deposit on the tenant's OWN property
  // (deposits self-route across the portfolio), an expense on the property being
  // imported. It used to take a tick in an "Always" column for expenses, which George
  // read as one more thing to understand for no gain ("i dont understand the always
  // collumn"); a rule is only ever a starting guess on the next statement, and every
  // one is listed and removable under Learned payees.
  // Deduped by pattern (a repeat payee → one rule), then SCREENED for specificity: a
  // pattern that also appears on a line belonging to a different payee is the bank's
  // boilerplate, not a payee, and learning it would make one rule swallow them all.
  // Computed here rather than inside the mutation so the footer can say what won't be
  // remembered BEFORE the landlord presses Save.
  const learned = useMemo(() => {
    const ruleByPattern = new Map();
    for (const r of resolved) {
      if (!r.checked) continue;
      const pattern = payeeOf(r.row.txn.description);
      if (!pattern) continue;
      if (r.kind === 'tenant' && r.tenant) {
        ruleByPattern.set(pattern.toUpperCase(), { type: 'rule', pattern, targetKey: targetKeyOf(r), property_id: r.tenant.property_id, target_kind: 'tenant', lease_id: r.tenant.lease_id, cam_label: null });
      } else if (r.kind.startsWith('expense_')) {
        ruleByPattern.set(pattern.toUpperCase(), { type: 'rule', pattern, targetKey: targetKeyOf(r), property_id: expenseProp, target_kind: r.kind, lease_id: null, cam_label: (r.kind === 'expense_cam' || r.kind === 'expense_other') ? (r.label || null) : null });
      }
      // ⚠ Slice 4c learns NEITHER other income NOR a security deposit, on purpose.
      // A rule fires on the payee, and a tenant's payee string is identical whether
      // they are paying rent, a late fee or a deposit — so learning "PAYEE → security
      // deposit" would reclassify every future rent payment from that tenant as a
      // deposit, silently, in the direction that corrupts the Ledger. The recurring-
      // payee argument that justifies learning a vendor is at its weakest here: a late
      // fee happens when someone is late, and a deposit happens once per tenancy.
    }
    const lines = resolved.map((r) => ({ description: r.row.txn.description, targetKey: targetKeyOf(r) }));
    const { keep, rejected } = screenRulePatterns([...ruleByPattern.values()], lines, ctx?.ownNames || []);
    return { keep: keep.map(({ targetKey, ...e }) => e), rejected };
  }, [resolved, expenseProp, payeeOf, ctx]);

  // CAM & tax estimates read from the statement: for each CHECKED tenant deposit tagged
  // to a month, back out CAM&tax = deposit − base − roof (deriveEstimateFromDeposit).
  // Keep the LATEST month's figure per lease (a mid-statement escalation makes the newest
  // month the current truth). The base rent is exact from the lease, so this is pure
  // arithmetic — no AI. Shown for the landlord to tick + Save; nothing writes on its own.
  const estimateSuggestions = useMemo(() => {
    if (!ctx) return [];
    const byLease = new Map();
    for (const r of resolved) {
      if (!r.checked || r.kind !== 'tenant' || !r.tenant || r.toRecon || !r.month || r.row.duplicate) continue;
      const derived = deriveEstimateFromDeposit(r.row.txn.amount, r.tenant, r.month);
      if (!derived) continue;
      const prev = byLease.get(r.tenant.lease_id);
      if (!prev || r.month >= prev.month) {
        byLease.set(r.tenant.lease_id, { lease_id: r.tenant.lease_id, tenant: r.tenant, month: r.month, deposit: r.row.txn.amount, year: r.row.year, derived });
      }
    }
    return [...byLease.values()].sort((a, b) => a.tenant.tenant_name.localeCompare(b.tenant.tenant_name));
  }, [ctx, resolved]);

  // The gross leases the pass above deliberately skipped (deriveEstimateFromDeposit
  // refuses one outright): a gross deposit IS the whole flat rent, so "deposit − base"
  // hands back the expense share the breakdown just carved OUT of that rent — proposing
  // it as an estimate would bill the same money a second time. Named here on exactly
  // the same conditions the suggestions use, because an unexplained absence reads as
  // the importer having simply missed those tenants.
  const grossDeposits = useMemo(() => {
    if (!ctx) return [];
    const names = new Set();
    for (const r of resolved) {
      if (!r.checked || r.kind !== 'tenant' || !r.tenant || r.toRecon || !r.month || r.row.duplicate) continue;
      if (r.tenant.gross) names.add(r.tenant.tenant_name);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [ctx, resolved]);

  // Smart pre-tick (George): a NEW estimate is pre-ticked; a change to an EXISTING one
  // arrives unticked, so a short deposit can never quietly lower a good estimate.
  const estChecked = (s) => {
    const ov = estOverrides[s.lease_id];
    return ov !== undefined ? ov : !s.tenant.anyEstimate;
  };
  const estToApply = estimateSuggestions.filter(estChecked);

  const save = useMutation({
    mutationFn: async () => {
      const entries = [];
      // Estimate writes go FIRST so the year's billing resyncs to base + the new estimate
      // before the deposits book — then each deposit settles its month exactly.
      const estEntries = estToApply.map((s) => ({
        type: 'estimate', lease_id: s.lease_id, property_id: s.tenant.property_id, year, est_cam_annual: s.derived.annual,
      }));
      for (const r of resolved) {
        if (!r.checked) continue;
        if (r.kind === 'tenant' && r.tenant) {
          entries.push({
            type: 'payment', lease_id: r.tenant.lease_id, property_id: r.tenant.property_id, year: r.row.year,
            amount: r.row.txn.amount, date: r.row.txn.date, description: r.row.txn.description,
            period_month: r.month || null, reconInvoiceId: r.toRecon ? r.tenant.reconInvoiceId : null, hash: r.row.hash,
          });
        // Every expense line carries the day the bank printed on it (0074) — the same
        // `txn.date` the payment branch above has always passed through.
        } else if (r.kind === 'expense_cam') {
          entries.push({ type: 'cam', property_id: expenseProp, year: r.row.year, amount: r.row.txn.amount, date: r.row.txn.date, label: r.label || 'Imported expense', billable: true, hash: r.row.hash });
        } else if (r.kind === 'expense_other') {
          entries.push({ type: 'cam', property_id: expenseProp, year: r.row.year, amount: r.row.txn.amount, date: r.row.txn.date, label: r.label || 'Other', billable: false, hash: r.row.hash });
        } else if (r.kind === 'expense_tax') {
          entries.push({ type: 'tax', property_id: expenseProp, year: r.row.year, amount: r.row.txn.amount, date: r.row.txn.date, label: payeeLabel(payeeOf(r.row.txn.description), 'Property tax'), hash: r.row.hash });
        } else if (r.kind === 'expense_roof') {
          entries.push({ type: 'roof', property_id: expenseProp, year: r.row.year, amount: r.row.txn.amount, date: r.row.txn.date, label: payeeLabel(payeeOf(r.row.txn.description), 'Roof'), hash: r.row.hash });
        } else if (r.kind === 'other_income') {
          entries.push({
            type: 'income', property_id: expenseProp, lease_id: r.leaseId || null,
            year: r.row.year, amount: r.row.txn.amount, date: r.row.txn.date,
            category: r.category || 'other',
            label: payeeLabel(payeeOf(r.row.txn.description), incomeCategoryLabel(r.category)),
            description: r.row.txn.description, hash: r.row.hash,
          });
        } else if (r.kind === 'deposit_held') {
          // Records that the deposit ARRIVED. Writes no row and never touches
          // leases.security_deposit — what is held is what the lease says, and
          // overwriting it with the bank figure would collapse the two independent
          // sources into one and destroy the cross-check between them.
          entries.push({
            type: 'deposit', property_id: expenseProp, lease_id: r.leaseId,
            year: r.row.year, amount: r.row.txn.amount, hash: r.row.hash,
          });
        // Money the OWNER took out. It is a `cam` entry like any not-billed expense —
        // the ONE thing that separates it is the `distribution` category riding along,
        // which api.js writes onto the bucket record and which every expense subtotal
        // then excludes (expenseCategories.js `isOwnerCategory`). No table of its own,
        // and still no way for it to reach a tenant's bill: `billable: false` keeps it
        // out of cam_total exactly as it keeps any absorbed cost out.
        //
        // The BUCKET IS THE PERSON. `party` names it when the landlord typed one —
        // usually blank for a cheque, since a bank publishes number, date, ref and
        // amount but never the payee — and the bucket is renamed on Financials after.
        } else if (r.kind === 'owner_draw') {
          entries.push({
            type: 'cam', property_id: expenseProp, year: r.row.year,
            amount: r.row.txn.amount, date: r.row.txn.date,
            label: String(r.party || '').trim() || payeeLabel(payeeOf(r.row.txn.description), 'Owner distribution'),
            billable: false, category: 'distribution',
            hash: r.row.hash,
          });
        }
      }
      // Every transcribed line rides along with its disposition — including the ones
      // that wrote nothing, which is the entire point: an unrecognized line left
      // untouched used to vanish without a trace.
      const lines = resolved.map((r) => ({
        hash: r.row.hash, year: r.row.year, date: r.row.txn.date,
        description: r.row.txn.description, amount: r.row.txn.amount,
        direction: r.row.txn.direction,
        disposition: r.disposition, ignore_reason: r.ignoreReason,
      }));
      return applyStatementImport({ propertyId: expenseProp, year, fileName, accountHint, storagePath, entries: [...estEntries, ...entries, ...learned.keep], lines });
    },
    onSuccess: (res) => onSaved(res),
  });

  // Draft the shortfall letter for a short-paid deposit row (from ctx — no fetch).
  function draftShortfallLetter(r) {
    const t = r.tenant;
    if (!t || !r.mismatch) return;
    const scheduled = r.mismatch.projected;
    const received = r.row.txn.amount;
    setLetterDraft(buildPaymentShortfallEmail({
      business: ctx.businessByProperty?.[t.property_id] || null,
      tenant_name: t.tenant_name,
      contact_name: t.contact_name,
      tenant_email: t.tenant_email,
      propertyName: t.property_name,
      monthLabel: r.month ? `${MONTH_NAMES[r.month - 1]} ${r.row.year}` : null,
      scheduled,
      received,
      shortfall: scheduled - received,
      paidDate: r.row.txn.date,
    }));
  }

  if (ctxFailed) {
    return (
      <div>
        <p className="note-msg danger">
          Your statement was read fine — {parsed.transactions.length} line{parsed.transactions.length === 1 ? '' : 's'} —
          but the ledger it needs to match them against didn’t load, so there’s nothing to review yet.
          Nothing was saved. {ctxError?.message ? `(${ctxError.message})` : ''}
        </p>
        <div className="btn-row">
          <button type="button" onClick={() => retryCtx()}>Try again</button>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
    );
  }
  // The statement itself is already transcribed by this point — what's still loading
  // is the ledger (each tenant's schedule + coverage), so say that, not "reading".
  if (!ctx || !matched) return <p className="muted">Loading your ledger to match these lines…</p>;

  const rows = resolved;
  // One collapsible section per statement month (each line's own date decides its month).
  const monthGroups = buildMonthGroups(rows);
  const dupes = rows.filter((r) => r.row.duplicate);

  // Footer summary of exactly what Save writes.
  const willPay = rows.filter((r) => r.checked && r.kind === 'tenant' && r.tenant);
  const willExpense = rows.filter((r) => r.checked && r.kind.startsWith('expense_'));
  const payTotal = willPay.reduce((s, r) => s + r.row.txn.amount, 0);
  const expTotal = willExpense.reduce((s, r) => s + r.row.txn.amount, 0);
  const payTenants = new Set(willPay.map((r) => r.tenant.lease_id)).size;
  const mismatchCount = willPay.filter((r) => r.mismatch && !r.mismatch.escalation).length;
  // "Ignored" used to mean "not ticked", which conflated a decision the landlord made
  // with a line nobody had looked at — the exact ambiguity Slice 4a exists to end.
  // Now they are counted apart: left out ON PURPOSE, versus not placed at all.
  const leftOut = completeness.ignored;
  const alreadyPaidCount = rows.filter((r) => r.alreadyPaid && !r.checked && !r.row.duplicate).length;
  const nothingTicked = willPay.length === 0 && willExpense.length === 0;
  const reconciledCount = (recons || []).length;
  const closedYearLines = rows.filter((r) => r.checked && closedYears.has(r.row.year));
  const propName = (id) => ctx.properties.find((p) => p.id === id)?.name || '…';

  const acceptAllConfident = () => {
    const patch = {};
    rows.forEach((r) => {
      if (!r.row.duplicate && (r.row.confidence === 'high' || r.row.confidence === 'rule') && !r.row.txn.needsReview) patch[r.i] = { ...overrides[r.i], checked: true };
    });
    setOverrides((o) => ({ ...o, ...patch }));
  };

  return (
    <div className="stmt-review">
      <div className="panel-head" style={{ alignItems: 'flex-start' }}>
        <div>
          <strong>Review statement — {fileName || 'statement'}</strong>
          <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
            {parsed.transactions.length} line{parsed.transactions.length === 1 ? '' : 's'} parsed · {parsed.skippedLines.length} skipped
            {pdfLane ? ' · transcribed from a PDF — check the count against your statement' : ''}
            {accountHint ? ` · account ${accountHint}` : ''}
          </div>
          {(parsed.warnings || []).map((w, i) => <div key={i} className="note-msg warn" style={{ marginTop: 6 }}>{w}</div>)}
        </div>
        <div className="row" style={{ gap: 8 }}>
          {/* The two optional AI helpers sit together in their own quiet cluster —
              they're assistance, not the controls that decide this import. Only the
              one you clicked says "Suggesting…"; the other simply waits its turn. */}
          {(unmatchedDeposits.length > 0 || unrecognized.length > 0) && (
            <span className="stmt-ai-row">
              {unmatchedDeposits.length > 0 && (
                <button
                  type="button"
                  className="stmt-ai"
                  disabled={!!aiOp}
                  onClick={suggestTenants}
                  title={`One small AI read suggests which tenant each unrecognized deposit is from, by name (~1–2¢${DEMO_MODE ? ' — free in the demo' : ''}). Suggestions only — every line still needs your tick before it saves.`}
                >
                  {aiOp === 'tenants' ? 'Suggesting…' : <>🤖 Suggest tenants <span className="stmt-ai-n">{unmatchedDeposits.length}</span></>}
                </button>
              )}
              {unrecognized.length > 0 && (
                <button
                  type="button"
                  className="stmt-ai"
                  disabled={!!aiOp}
                  onClick={suggestBuckets}
                  title={`One small AI read suggests a bucket for each unrecognized expense line (~1–2¢${DEMO_MODE ? ' — free in the demo' : ''}). Suggestions only — every line still needs your tick before it saves.`}
                >
                  {aiOp === 'buckets' ? 'Suggesting…' : <>🤖 Suggest buckets <span className="stmt-ai-n">{unrecognized.length}</span></>}
                </button>
              )}
            </span>
          )}
          {aiPending.length > 0 && (
            <button type="button" className="ghost" onClick={acceptAllAi} title="Tick every line the AI named — review them first; nothing is written until you press Save">
              ✓ Accept {aiPending.length} AI match{aiPending.length === 1 ? '' : 'es'}
            </button>
          )}
          <button type="button" className="ghost" onClick={acceptAllConfident}>✓ Accept all confident</button>
          <button type="button" className="secondary" onClick={onCancel}>Cancel</button>
        </div>
      </div>
      {aiErr && <div className="note-msg danger" style={{ margin: '8px 0' }}>{aiErr}</div>}

      <div className="stmt-propline">
        <label>
          Expenses will be recorded on:{' '}
          <select className="text-input" value={expenseProp} onChange={(e) => setExpensePropPick(e.target.value)} style={{ maxWidth: 240, display: 'inline-block' }}>
            {ctx.properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        {remembered && !expensePropPick && (
          <span className="muted" style={{ fontSize: 12 }}>Account {accountHint} — last imported into {propName(remembered)}</span>
        )}
        <span className="muted" style={{ fontSize: 12 }}>Tenant deposits post to each tenant's own property automatically.</span>
      </div>
      {matched.propertyVote && matched.propertyVote.propertyId !== expenseProp && (
        <div className="note-msg warn" style={{ margin: '8px 0' }}>
          {matched.propertyVote.count} of {matched.propertyVote.total} matched deposits belong to <strong>{matched.propertyVote.propertyName}</strong> tenants — record this statement's expenses there instead?{' '}
          <button type="button" className="btn-sm secondary" onClick={() => setExpensePropPick(matched.propertyVote.propertyId)}>Switch</button>
        </div>
      )}

      {monthGroups.map((g) => (
        <MonthGroup key={g.key} g={g} defaultOpen={monthGroups.length === 1 || g.needsReview > 0}>
          <Group title={`Money in · ${g.moneyIn.length}`} rows={g.moneyIn} ctx={ctx} year={year} closedYears={closedYears} expenseProp={expenseProp} setOv={setOv} buckets={bucketOptions} onNewBucket={addSessionBucket} onDraftLetter={draftShortfallLetter} payeeOf={payeeOf} />
          <Group title={`Money out · ${g.moneyOut.length}`} rows={g.moneyOut} ctx={ctx} year={year} closedYears={closedYears} expenseProp={expenseProp} setOv={setOv} buckets={bucketOptions} onNewBucket={addSessionBucket} payeeOf={payeeOf} />
        </MonthGroup>
      ))}
      {dupes.length > 0 && <DupeGroup rows={dupes} ctx={ctx} year={year} closedYears={closedYears} setOv={setOv} buckets={bucketOptions} onNewBucket={addSessionBucket} payeeOf={payeeOf} />}
      {parsed.skippedLines.length > 0 && <SkippedGroup skipped={parsed.skippedLines} />}

      {(estimateSuggestions.length > 0 || grossDeposits.length > 0) && (
        <div className="stmt-group stmt-estimates">
          <div className="fin-subhead">CAM &amp; tax estimates read from this statement</div>
          {estimateSuggestions.length > 0 && (
          <p className="muted" style={{ fontSize: 12, marginTop: -4, marginBottom: 8 }}>
            The base rent is exact from each lease, so a deposit minus the base is the tenant's CAM &amp; tax. Tick to
            store it as the tenant's estimate — it then bills all year and the actual settles it at year end. A new
            estimate is pre-ticked; a change to one you've already set arrives unticked, so a short deposit can't quietly
            lower it.
          </p>
          )}
          {estimateSuggestions.length > 0 && (
          <div className="table-wrap">
            <table className="stmt-table">
              <thead><tr><th title="Tick to store this as the tenant's CAM & tax estimate">Set</th><th>Tenant</th><th>Read from the statement</th></tr></thead>
              <tbody>
                {estimateSuggestions.map((s) => {
                  const on = estChecked(s);
                  const roof = Number(s.derived.roof) || 0;
                  return (
                    <tr key={s.lease_id} className={on ? undefined : 'stmt-off'}>
                      <td><input type="checkbox" checked={on} onChange={(e) => setEstOverrides((o) => ({ ...o, [s.lease_id]: e.target.checked }))} /></td>
                      <td className="stmt-desc">
                        {s.tenant.tenant_name}
                        <div className="muted" style={{ fontSize: 11 }}>
                          from {MONTH_NAMES[s.month - 1]} · {s.tenant.anyEstimate ? `currently ${money(s.tenant.camTaxAnnual)}/yr` : 'none set yet'}
                        </div>
                      </td>
                      <td title="All figures shown to 4 decimals so you can validate the math">
                        {money4(s.deposit)} deposit − {money4(s.derived.base)} base{roof > 0.005 ? ` − ${money4(roof)} roof` : ''} = <strong>{money4(s.derived.monthly)}/mo</strong> → <strong>{money4(s.derived.annual)}/yr</strong>
                        {s.derived.psf != null && <> · <span title="Annual ÷ square footage — the $/SF rate">${s.derived.psf.toFixed(4)}/SF</span></>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
          {grossDeposits.length > 0 && (
            <p className="muted" style={{ fontSize: 12, marginTop: estimateSuggestions.length > 0 ? 10 : -4, marginBottom: 0 }}>
              No estimate is read for <strong>{listNames(grossDeposits)}</strong> — {grossDeposits.length > 1 ? 'those leases are' : 'that lease is'} gross,
              so the deposit is the whole rent with taxes &amp; CAM already inside it. Their share is carved out of that rent
              on the Financials breakdown instead, never billed on top.
            </p>
          )}
        </div>
      )}

      <div className="stmt-footer">
        {reconciledCount > 0 && willExpense.length > 0 && (
          <div className="note-msg warn">
            FY{year} has {reconciledCount} reconciled tenant{reconciledCount === 1 ? '' : 's'} on {propName(expenseProp)} — new expenses change their actuals. Consider ↩ Undo on those reconciliations and re-running them after the import.
          </div>
        )}
        {closedYearLines.length > 0 && (
          <div className="note-msg warn">
            {closedYearLines.length} line{closedYearLines.length === 1 ? '' : 's'} fall in a closed fiscal year — they import normally, but that year's History snapshot is stale until you close it again.
          </div>
        )}
        {alreadyPaidCount > 0 && (
          <div className="note-msg warn">
            {alreadyPaidCount} line{alreadyPaidCount === 1 ? '' : 's'} would settle a month that is <strong>already recorded as paid</strong> — left unticked so the rent isn't recorded twice. Tick one anyway if the tenant genuinely paid that month more than once.
          </div>
        )}
        {learned.rejected.length > 0 && (
          <div className="note-msg warn">
            {learned.rejected.map((x) => (x.own
              ? `“${x.pattern}” names your own company, not a payee`
              : `${x.count} lines share the wording “${x.pattern}” — that's your bank's own wording, not a payee`)).join('; ')}
            , so it won't be remembered. These lines still import; name them individually under <strong>Learned payees</strong> if you want them matched automatically.
          </div>
        )}
        {learned.keep.length > 0 && (
          <div className="muted" style={{ fontSize: 12 }}>
            Saving also remembers <strong>{learned.keep.length}</strong> payee{learned.keep.length === 1 ? '' : 's'} → where {learned.keep.length === 1 ? 'it goes' : 'they go'}, so the next statement sorts itself. Only the payee is remembered, never the month — every statement is dated from its own lines. Change or drop any of them under <strong>Learned payees</strong> on the Ledger tab.
          </div>
        )}
        {nothingTicked && (
          <div className="note-msg warn">
            Nothing is ticked yet — tick the <strong>Import</strong> box on each line you want recorded.
            {unmatchedDeposits.length > 0 && <> If your bank abbreviated the payees, the <strong>🤖 helper</strong> above will name them for you.</>}
          </div>
        )}
        {/* Slice 4a — the completeness statement. Every line of this statement is
            recorded here whatever you decide, so this is the promise that nothing
            went missing rather than a summary of what got ticked. Money IN nags
            harder: an unplaced deposit may be rent that should have settled a month,
            which makes a tenant read short on the Ledger. */}
        {completeness.total > 0 && (
          <div className={`note-msg ${completeness.unplacedIn > 0 ? 'warn' : ''}`}>
            <strong>{completenessSentence(completeness)}.</strong>{' '}
            {/* The all-clear says so out loud. Round 6 rendered this block only when
                something was unplaced, which made completenessSentence's "N of N ✓"
                branch unreachable — and the promise that nothing went missing is
                worth most at the moment it is actually true. */}
            {!completeness.unplaced
              ? <>Every line this statement showed is on record.</>
              : completeness.unplacedIn > 0
                ? <>Some of the money you haven’t placed came <strong>in</strong> — if any of it is rent, tick it now, or it will read as a month the tenant never paid.</>
                : <>Unplaced lines are still recorded and will show under <strong>Money not yet placed</strong> on the Ledger, so nothing is lost — place them whenever you like.</>}
          </div>
        )}
        <MutationError of={[save]} />
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10 }}>
          <div className="muted">
            <strong>{willPay.length}</strong> payment{willPay.length === 1 ? '' : 's'} to <strong>{payTenants}</strong> tenant{payTenants === 1 ? '' : 's'} · {money(payTotal)} in
            {mismatchCount > 0 && <> · <strong>{mismatchCount}</strong> ≠ projected</>}
            {' — '}<strong>{willExpense.length}</strong> expense{willExpense.length === 1 ? '' : 's'} · {money(expTotal)} out
            {leftOut > 0 && <> — <strong>{leftOut}</strong> left out on purpose</>}
            {completeness.unplaced > 0 && <> — <strong>{completeness.unplaced}</strong> not placed</>}
            {estToApply.length > 0 && <> — <strong>{estToApply.length}</strong> CAM &amp; tax estimate{estToApply.length === 1 ? '' : 's'}</>}
          </div>
          <button type="button" disabled={save.isPending || nothingTicked} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save to ledger'}
          </button>
        </div>
      </div>

      {letterDraft && (
        <EmailComposeModal
          title="Rent shortfall notice"
          to={letterDraft.to}
          subject={letterDraft.subject}
          body={letterDraft.body}
          onClose={() => setLetterDraft(null)}
        />
      )}
    </div>
  );
}

// The label a tax or roof payment carries in its itemized list: the payee the bank
// named, tidied ("COOK COUNTY TREASURER" → "Cook County Treasurer"), so three
// instalments read as three recognizable lines instead of three identical rows.
// Takes the already-resolved payee (from the screen's shared `payeeOf`) so the label and
// the learned rule name the same thing, and the fallback the list uses when the bank
// named nobody recognizable.
function payeeLabel(payee, fallback) {
  if (!payee) return fallback;
  return payee.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase()).slice(0, 60);
}

// What a resolved row RESOLVES TO — the identity the specificity screen compares. Two
// lines with the same key are the same payee; two with different keys are not, so a
// pattern matching both is boilerplate. null = the line resolves to nothing (ignored /
// unpicked) and therefore never contradicts anyone.
function targetKeyOf(r) {
  if (r.kind === 'tenant' && r.tenant) return `lease:${r.tenant.lease_id}`;
  if (r.kind === 'expense_cam' || r.kind === 'expense_other') return `${r.kind}:${(r.label || '').toLowerCase()}`;
  if (r.kind === 'expense_tax' || r.kind === 'expense_roof') return r.kind;
  // Slice 4c — these two are deliberately NOT learned as rules (see the note in the
  // draft-rule builder), but they still resolve to a target, so a pattern that hits an
  // income line AND a rent line is correctly seen as boilerplate rather than a payee.
  if (r.kind === 'other_income') return `income:${r.category || 'other'}`;
  if (r.kind === 'deposit_held') return `deposit:${r.leaseId || ''}`;
  // A distribution or a transfer is as much a "payee" as a vendor is — and learning it
  // is the whole point, since the same distribution line recurs monthly. These keys are
  // also what OWN_NAME_TARGETS (statementMatch.js) checks against, so a pattern naming
  // the landlord's own corporation is allowed to learn HERE while still being refused
  // as a tenant.
  if (ENTITY_PICKS.has(r.kind)) return r.kind;
  return null;
}

// The one pick → { kind, lease_id?, label? } decoder, shared by the review's overrides
// and the Learned-payees manager's retarget dropdown (LearnedPayeesPanel.js).
export function resolvePick(pick) {
  if (!pick) return null;
  if (pick.startsWith('lease:')) return { kind: 'tenant', lease_id: pick.slice(6) };
  if (pick.startsWith('cam:')) return { kind: 'expense_cam', label: pick.slice(4) };
  if (pick.startsWith('other:')) return { kind: 'expense_other', label: pick.slice(6) };
  if (pick === 'expense_tax' || pick === 'expense_cam' || pick === 'expense_roof' || pick === 'ignore') return { kind: pick };
  // Money that crossed the bank but is not this building's income or expense. Since the
  // entity ledger was retired (2026-08-12) a distribution writes a NOT-BILLED expense
  // line carrying the `distribution` category, and a transfer still writes nothing at
  // all — so neither can reach cam_total, and neither can move a tenant's bill.
  if (ENTITY_PICKS.has(pick)) return { kind: pick };
  // Slice 4c — money IN that is not rent. Income carries its category; a deposit
  // carries its LEASE, because "whose deposit is it" is the whole question and a
  // deposit with no tenant reconciles against nothing.
  if (pick.startsWith('income:')) return { kind: 'other_income', category: pick.slice(7) };
  if (pick.startsWith('deposit:')) return { kind: 'deposit_held', lease_id: pick.slice(8) };
  return null;
}

// The destinations that are money movement rather than the building's income or expense.
// A distribution writes a NOT-BILLED cam_line_items row carrying the `distribution`
// category; a transfer writes nothing at all, because its disposition IS the record.
// Neither can reach cam_total, so neither can move a tenant's bill.
const ENTITY_PICKS = new Set(['owner_draw', 'transfer']);

// One statement month, collapsible. The header carries live counts — total lines, money
// in / out, and matched vs need-review — so a scan tells you which months want a look.
// All-matched months start collapsed; a month with rows needing review, or a single-month
// statement, starts open. `useState(defaultOpen)` pins openness lazily at mount, so ticking
// a row never snaps its month shut mid-work while the header counts keep updating.
function MonthGroup({ g, defaultOpen, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="stmt-month">
      <button type="button" className="ghost stmt-month-head" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} {g.label}
        <span className="muted">
          {' — '}{g.count} line{g.count === 1 ? '' : 's'}
          {g.moneyIn.length > 0 ? ` · ${money0(g.inTotal)} in` : ''}
          {g.moneyOut.length > 0 ? ` · ${money0(g.outTotal)} out` : ''}
          {' · '}{g.needsReview > 0 ? `${g.matched} matched · ${g.needsReview} need review` : 'all matched ✓'}
        </span>
      </button>
      {open && <div className="stmt-month-body">{children}</div>}
    </div>
  );
}

// Every column carries a name. The include tick and the confidence chip used to sit
// under blank headers, which left "Always" looking like an empty column with its
// checkbox stranded on the far left (George: "the always boxes arent there … there
// are on the left side"). One shared header row so the two tables can't drift.
function HeadRow() {
  return (
    <thead>
      <tr>
        <th title="Tick a line to include it — nothing is written until you press Save">Import</th>
        <th>Date</th>
        <th>Description</th>
        <th className="num">Amount</th>
        <th>Record as</th>
        {/* The column has always been editable and nobody found it — a control nobody finds
            is not a control (George, 2026-08-13, on tenants who pay a month early). */}
        <th title="Which month a tenant's payment settles — dated from the line itself, and yours to change. A tenant paying early or late is filed on the month the rent was FOR, not the day it cleared.">For month <span className="muted" style={{ fontWeight: 400 }}>· editable</span></th>
        <th title="How confident the match is">Match</th>
      </tr>
    </thead>
  );
}

function Group({ title, rows, ctx, year, closedYears, expenseProp, setOv, buckets, onNewBucket, onDraftLetter, payeeOf }) {
  if (!rows.length) return null;
  return (
    <div className="stmt-group">
      <div className="fin-subhead">{title}</div>
      <div className="table-wrap">
        <table className="stmt-table">
          <HeadRow />
          <tbody>
            {rows.map((r) => <ReviewRow key={r.i} r={r} ctx={ctx} year={year} closedYears={closedYears} expenseProp={expenseProp} setOv={setOv} buckets={buckets} onNewBucket={onNewBucket} onDraftLetter={onDraftLetter} payeeOf={payeeOf} />)}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ReviewRow({ r, ctx, year, closedYears, expenseProp, setOv, buckets = [], onNewBucket, onDraftLetter, payeeOf, dupe = false }) {
  const { row } = r;
  const txn = row.txn;
  const isIn = txn.direction === 'in';
  const txnMonth = monthOfDate(txn.date);
  // The wording this line would be remembered by, with the bank's rail words stripped —
  // null when nothing distinctive survives. Resolved by the screen's shared `payeeOf`,
  // so what the row says it remembers is exactly what Save writes.
  const payee = payeeOf ? payeeOf(txn.description) : suggestRulePattern(txn.description);
  // The new-bucket mini-form, opened by picking "＋ New bucket…" in the dropdown.
  const [addingBucket, setAddingBucket] = useState(false);
  // Its money-in twin — naming a kind of other income that isn't on the list yet.
  const [namingIncome, setNamingIncome] = useState(false);
  const [newIncome, setNewIncome] = useState('');
  const [newName, setNewName] = useState('');
  const [newBillable, setNewBillable] = useState(true);
  // '' = follow the built-in default for whatever name is being typed; once the user
  // picks, their choice sticks even if they keep editing the name.
  const [newCategory, setNewCategory] = useState('');
  const effectiveCategory = newCategory || defaultCategoryFor(newName) || '';
  const pickValue =
    r.kind === 'tenant' && r.leaseId ? `lease:${r.leaseId}`
      : r.kind === 'expense_cam' && r.label ? `cam:${r.label}`
      : r.kind === 'expense_other' ? `other:${r.label || 'Other'}`
      // Slice 4c — the matcher can SUGGEST a deposit, so the select has to be able to
      // show one it wasn't told about; the lease is what identifies it.
      : r.kind === 'deposit_held' && r.leaseId ? `deposit:${r.leaseId}`
      : r.kind === 'other_income' ? `income:${r.category || 'other'}`
      : r.kind === 'unmatched' ? '' : r.kind;
  const candidateIds = new Set((row.candidates || []).map((c) => c.lease_id));
  // Standing in Pershing Plaza, the list should BE Pershing Plaza's tenants — the rest
  // of the portfolio drops to a secondary group rather than padding out one long list.
  const homeName = expenseProp ? ctx.properties.find((p) => p.id === expenseProp)?.name || null : null;
  const pickable = ctx.tenants.filter((t) => !candidateIds.has(t.lease_id));
  const homeTenants = homeName ? pickable.filter((t) => t.property_id === expenseProp) : pickable;
  const otherTenants = homeName ? pickable.filter((t) => t.property_id !== expenseProp) : [];
  // The deposit list is built from ALL of this property's tenants, not `pickable` —
  // the matcher suggests a deposit for the tenant it RECOGNIZED, and that tenant is a
  // candidate, so filtering candidates out would leave the select with no option
  // matching its own value and render blank. (The same trap the label comment above
  // guards against, one optgroup over.)
  const depositTenants = expenseProp
    ? ctx.tenants.filter((t) => t.property_id === expenseProp)
    : ctx.tenants;
  // Make sure the row's CURRENT label always appears in its optgroup, even when
  // it isn't (yet) one of the shared buckets.
  const billableBuckets = [...buckets.filter((b) => b.billable)];
  const otherBuckets = [...buckets.filter((b) => !b.billable)];
  if (r.kind === 'expense_cam' && r.label && !billableBuckets.some((b) => b.label.toLowerCase() === r.label.toLowerCase())) billableBuckets.unshift({ label: r.label, billable: true });
  if (r.kind === 'expense_other' && r.label && !otherBuckets.some((b) => b.label.toLowerCase() === r.label.toLowerCase())) otherBuckets.unshift({ label: r.label, billable: false });
  const confirmNewBucket = () => {
    const label = newName.trim();
    if (!label) return;
    onNewBucket?.(label, newBillable, effectiveCategory || null);
    setOv(r.i, { pick: newBillable ? `cam:${label}` : `other:${label}` });
    setAddingBucket(false);
    setNewName('');
    setNewBillable(true);
    setNewCategory('');
  };
  // A write-in income category. Unlike a bucket it persists NOTHING of its own — the key is
  // `custom:<slug>`, valid by shape, and it exists from the moment a row carries it. So
  // there is no onNewCategory callback and nothing to clean up if the review is cancelled.
  const confirmNewIncome = () => {
    const key = customCategoryKey(newIncome);
    if (!key) return;
    setOv(r.i, { pick: `income:${key}` });
    setNamingIncome(false);
    setNewIncome('');
  };
  return (
    <tr className={r.checked ? undefined : 'stmt-off'}>
      <td>
        <input type="checkbox" checked={r.checked} onChange={(e) => setOv(r.i, { checked: e.target.checked })} title={dupe ? 'Import anyway' : 'Include this line'} />
      </td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {fmtDate(txn.date)}
        {row.year !== year && <span className="badge info" style={{ marginLeft: 5 }} title="This line's own date decides its fiscal year">FY {row.year}</span>}
        {closedYears.has(row.year) && <span className="badge warn" style={{ marginLeft: 5 }} title="This fiscal year was closed — it still imports; re-close the year to refresh its snapshot">FY {row.year} closed</span>}
      </td>
      <td className="stmt-desc" title={txn.description}>
        {txn.description}
        {txn.needsReview && <span className="badge warn" style={{ marginLeft: 5 }} title="This line's amount doesn't match the statement's running balance — double-check it">check</span>}
        {dupe && <span className="badge info" style={{ marginLeft: 5 }}>already imported</span>}
      </td>
      <td className="num">{money(txn.amount)}</td>
      <td>
        <select
          className="text-input"
          value={pickValue}
          onChange={(e) => {
            if (e.target.value === '__new') { setAddingBucket(true); return; }
            // Its money-in twin (2026-08-13): name a kind of other income the six
            // built-ins don't cover, exactly as ＋ New bucket… does for an expense.
            if (e.target.value === '__new_income') { setNamingIncome(true); return; }
            setOv(r.i, { pick: e.target.value || 'ignore' });
          }}
        >
          {isIn ? (
            <>
              <option value="">{KIND_LABEL.unmatched}</option>
              {(row.candidates || []).length > 0 && (
                <optgroup label="Suggested">
                  {row.candidates.map((c) => (
                    <option key={c.lease_id} value={`lease:${c.lease_id}`}>
                      {c.tenant_name}{c.property_id !== expenseProp ? ` — ${c.property_name}` : ''} ({Math.round(c.score * 100)}%)
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label={homeName ? `${homeName} tenants` : 'All tenants'}>
                {homeTenants.map((t) => (
                  <option key={t.lease_id} value={`lease:${t.lease_id}`}>{t.tenant_name}</option>
                ))}
              </optgroup>
              {/* One bank account serves the whole portfolio, so a deposit from another
                  property's tenant can legitimately land on this statement — those stay
                  reachable, just out of the way of the property you're standing in. */}
              {otherTenants.length > 0 && (
                <optgroup label="Other properties">
                  {otherTenants.map((t) => (
                    <option key={t.lease_id} value={`lease:${t.lease_id}`}>{t.tenant_name} — {t.property_name}</option>
                  ))}
                </optgroup>
              )}
              {/* The deposits that are NOT rent. Booking one of these
                  against a lease would credit that tenant's invoice and make the
                  Ledger read the month over-paid, which is why they need their own
                  home rather than the nearest lease. */}
              {/* Slice 4c — income the property really received that is not rent.
                  Booking a late fee against the tenant who paid it credits their
                  annual invoice, so the Ledger reads the month over-paid and the
                  Collected column reports rent that never arrived. */}
              <optgroup label="Other income — not rent">
                {/* The six built-ins, PLUS this row's own category when it is a write-in —
                    without that the select's value matches no option the moment a category
                    is named, and it blanks out over a pick that was actually made. */}
                {incomeCategoriesInUse([{ category: r.category }]).map((c) => (
                  <option key={c.key} value={`income:${c.key}`}>{c.label}</option>
                ))}
                <option value="__new_income">＋ New category…</option>
              </optgroup>
              {/* A deposit belongs to a TENANT — that is the whole question, so the
                  pick carries the lease rather than asking twice. Scoped to this
                  property's tenants: a deposit is from a tenant of the building whose
                  statement you are importing. */}
              {depositTenants.length > 0 && (
                <optgroup label="Security deposit from…">
                  {depositTenants.map((t) => (
                    <option key={t.lease_id} value={`deposit:${t.lease_id}`}>{t.tenant_name}</option>
                  ))}
                </optgroup>
              )}
              {/* Money the owner puts IN files as a transfer: recorded and placed, but
                  carrying no amount into any figure. It is deliberately NOT an income
                  category — every member of that list is money the property earned, and
                  the export prints the lot as revenue (otherIncome.js). */}
              <optgroup label="Not tenant rent">
                <option value="transfer">Transfer or money you put in</option>
              </optgroup>
              <option value="ignore">Ignore</option>
            </>
          ) : (
            <>
              <option value="expense_tax">Property taxes</option>
              <option value="expense_roof">Roof expense</option>
              <optgroup label="CAM buckets — billed to tenants">
                {billableBuckets.map((b) => <option key={b.label} value={`cam:${b.label}`}>{b.label}</option>)}
                <option value="expense_cam">CAM — general</option>
              </optgroup>
              <optgroup label="Not billed to tenants">
                {otherBuckets.map((b) => <option key={b.label} value={`other:${b.label}`}>{b.label}</option>)}
                {!otherBuckets.some((b) => b.label.toLowerCase() === 'other') && <option value="other:Other">Other — not billed</option>}
              </optgroup>
              <option value="__new">＋ New bucket…</option>
              {/* Money the owner took OUT. It writes a not-billed expense line like the
                  bucket above it, but carries the `distribution` category — which is
                  what keeps it out of every expense subtotal. A cost of the LLC itself
                  (registered agent, franchise tax) has no special destination any more:
                  it is a not-billed bucket like any other. */}
              <optgroup label="Not the building’s money">
                <option value="owner_draw">Owner distribution — money you took out</option>
                <option value="transfer">Transfer between my own accounts</option>
              </optgroup>
              <option value="ignore">Ignore</option>
            </>
          )}
        </select>
        {namingIncome && (
          <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="text-input"
              style={{ maxWidth: 150 }}
              placeholder="Category name (e.g. Signage)"
              value={newIncome}
              autoFocus
              onChange={(e) => setNewIncome(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmNewIncome(); } }}
            />
            <button type="button" className="btn-sm" onClick={confirmNewIncome} disabled={!newIncome.trim()}>Add</button>
            <button type="button" className="ghost btn-sm" onClick={() => { setNamingIncome(false); setNewIncome(''); }}>Cancel</button>
            {/* ⚠ Every category on this list is money the PROPERTY EARNED — one export
                prints the lot as revenue. Money the owner put IN is a transfer, and
                otherIncome.js refuses a `contribution` category for exactly this reason. */}
            <span className="muted" style={{ fontSize: 10.5, width: '100%' }}>
              Income the property earned. Money you put in yourself isn’t income — record that as a transfer.
            </span>
          </div>
        )}
        {addingBucket && (
          <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            <input
              className="text-input"
              style={{ maxWidth: 150 }}
              placeholder="Bucket name (e.g. Garbage)"
              value={newName}
              autoFocus
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); confirmNewBucket(); } }}
            />
            <label className="muted" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
              <input type="checkbox" checked={newBillable} onChange={(e) => setNewBillable(e.target.checked)} />
              bill to tenants via CAM
            </label>
            {/* Asked once, here, because this is the moment the bucket is born — and a
                bucket nobody categorizes is money that won't roll up to any tax line. */}
            <TaxCategorySelect
              className="text-input" style={{ maxWidth: 175, fontSize: 12 }}
              value={effectiveCategory}
              emptyLabel="Tax category…"
              onChange={(next) => setNewCategory(next)}
              title="Which category this bucket rolls up to on your reports. It changes reporting only — never what a tenant is billed."
            />
            <button type="button" className="btn-sm" onClick={confirmNewBucket} disabled={!newName.trim()}>Add</button>
            <button type="button" className="ghost btn-sm" onClick={() => { setAddingBucket(false); setNewName(''); }}>Cancel</button>
          </div>
        )}
        {/* Money out gets a one-click way out of the dropdown — "Ignore" is the last
            option under two optgroups, which is a long way to travel to say "not an
            expense". */}
        {!isIn && (
          r.kind === 'ignore' ? (
            <button type="button" className="ghost btn-sm" style={{ marginTop: 4 }} onClick={() => setOv(r.i, { pick: undefined, checked: undefined })} title="Put this line back in play">
              ↩ Undo ignore
            </button>
          ) : null
        )}
        {/* Slice 4a — an exclusion gets to say why, and the reason is stored with the
            line. Offered after the fact, never required: making it mandatory on the way
            out just teaches people to pick the first option, and an unexplained
            exclusion is still a decision.
            The matcher bins MORTGAGE / LOAN / TRANSFER / DRAW by keyword, which is a
            GUESS, not a decision — so those rows stay UNPLACED and this select is how
            the landlord confirms it ("Leave it out…"). Picking a reason is the act of
            deciding; on a row they already ignored by hand it just names the why. */}
        {r.kind === 'ignore' && (
          <select
            className="text-input" style={{ maxWidth: 190, fontSize: 11, marginTop: 4 }}
            value={r.ignoreReason || ''}
            onChange={(e) => {
              const v = e.target.value;
              setOv(r.i, v ? { pick: 'ignore', checked: false, reason: v } : { reason: undefined });
            }}
            title="Why this line is being left out. Recorded with the line so the register can explain itself later."
          >
            <option value="">{r.picked ? 'Why leave it out? (optional)' : 'Leave it out…'}</option>
            {IGNORE_REASONS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
          </select>
        )}
        {!isIn && (
          r.kind === 'ignore' ? null : (
            <button type="button" className="ghost btn-sm" style={{ marginTop: 4 }} onClick={() => setOv(r.i, { pick: 'ignore', checked: false })} title="Not an expense — leave this line out of the ledger entirely">
              ✕ Ignore
            </button>
          )
        )}
        {row.reason && <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>{row.reason}</div>}
        {r.kind === 'expense_other' && (
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>tracked for your records — not billed to tenants</div>
        )}
        {/* A transfer has no tick because it records nothing but itself —
            without this line an unticked row reads as "about to be dropped", which is
            the exact anxiety round 6 exists to remove. */}
        {/* A transfer has no tick — it records nothing but itself, so the PICK is the
            whole decision. Which leaves a hole when the MATCHER suggested it: the
            dropdown already reads "Transfer", so re-choosing it changes nothing and
            there is no way to say yes. Exactly the hole round 6 found on a
            matcher-ignored row, and the same answer — one click that IS the decision. */}
        {r.kind === 'transfer' && (
          r.picked ? (
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>recorded as a transfer — neither income nor expense</div>
          ) : (
            <button
              type="button" className="ghost btn-sm" style={{ marginTop: 4 }}
              onClick={() => setOv(r.i, { pick: 'transfer', checked: false })}
              title="Record this line as a transfer between your own accounts. It writes no income and no expense — the record is that you decided."
            >
              Confirm transfer
            </button>
          )
        )}
        {r.kind === 'owner_draw' && (
          <>
            {/* WHO — optional, and usually left blank here on purpose: a bank publishes
                no payee for a cheque, so most distributions get named afterwards by
                renaming the bucket on Financials. Offered anyway for the lines that DO
                name someone (an ACH to a member), so it needn't be a second trip.
                Whatever is typed BECOMES THE BUCKET NAME, which is how a distribution
                stays split by person without a table of its own. */}
            <input
              className="text-input" style={{ marginTop: 4, fontSize: 12 }}
              maxLength={120}
              placeholder="Paid to (optional)"
              value={r.party}
              onChange={(e) => setOv(r.i, { party: e.target.value })}
              title="Who this money went to. It becomes the name of the expense bucket, so distributions stay split by person. You can rename it later on Financials."
            />
            <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
              money you took out — it will not appear in NOI, in any expense total, or on any tenant’s bill
            </div>
          </>
        )}
        {r.alreadyPaid && !dupe && (
          // ⚠ The commonest cause of this is a tenant paying a month early or late, not a
          // duplicate — so the warning names the fix rather than only the problem (George,
          // 2026-08-13: "some tenants may pay in the month before for rent … if it comes up
          // as double in the statement reading"). The Month column beside it is editable.
          <div className="note-msg warn" style={{ marginTop: 4 }}>
            {MONTH_NAMES[r.month - 1]} is already recorded as paid — ticking this records it twice.
            {' '}If this cheque was for a different month, change <strong>Month</strong> →.
          </div>
        )}
        {/* The within-statement half of the same warning: two ticked lines for one tenant and
            one month. Nothing on the ledger is covered yet, so `alreadyPaid` above stays quiet
            — but saving both still settles that month twice over. Same fix, same column. */}
        {r.doubled && !r.alreadyPaid && !dupe && (
          <div className="note-msg warn" style={{ marginTop: 4 }}>
            Another line on this statement is also going to {MONTH_NAMES[r.month - 1]} for this tenant.
            {' '}If one of them was for a different month, change <strong>Month</strong> →.
          </div>
        )}
        {r.row.collision && !r.alreadyPaid && (
          <div className="note-msg warn" style={{ marginTop: 4 }}>possibly already recorded by hand — left unchecked</div>
        )}
      </td>
      <td>
        {/* ⚠ AN UNMATCHED DEPOSIT SHOWS THE MONTH BOX TOO, greyed, and it is the row that most
            needs it. The control was gated on `kind === 'tenant'`, so a deposit the matcher did
            not recognize — a second payment in one month, a cheque for next month, a tenant
            paying early — had an EMPTY cell, and nothing on screen suggested a month could be
            set at all until after a tenant had been picked. George: *"is this an option in the
            initial bank statement screening? so if it happens again the user can fix the problem
            early."* It is, and this is what made it invisible on exactly the wrong rows. */}
        {/* ⚠ `kind === 'ignore'` AND NOT PICKED is what an unrecognized deposit resolves to —
            the mapping above turns `row.kind === 'unmatched'` into `'ignore'`, so testing for
            'unmatched' here matches nothing. A row the landlord explicitly set to Ignore has
            `picked` true and is left alone. */}
        {isIn && r.kind === 'ignore' && !r.picked && (
          <select className="text-input" value="" disabled
            title="Pick a tenant on the left and this fills in with the month from the date the bank printed — then change it if the money was for a different month.">
            <option value="">— pick a tenant first</option>
          </select>
        )}
        {isIn && r.kind === 'tenant' && (
          r.toRecon ? (
            <span className="badge info" title="Matches this tenant's open reconciliation true-up — records against that invoice, no month">true-up</span>
          ) : (
            <>
              <select
                className="text-input"
                value={r.month ?? ''}
                title="Which month's rent this deposit pays — filled in from the date the bank printed on this line, so a May statement records May. Change it whenever the money was for a different month; your choice always wins. “— (lump)” leaves it untagged, and the ledger spreads it across the months still owed."
                onChange={(e) => setOv(r.i, { month: e.target.value })}
              >
                <option value="">— (lump)</option>
                {MONTH_NAMES.map((nm, mi) => <option key={nm} value={mi + 1}>{nm.slice(0, 3)}</option>)}
              </select>
              {/* A check big enough to cover several months, the whole year, or an open
                  true-up is deliberately left untagged — say so, otherwise an empty
                  month box reads as something that failed to fill in. */}
              {!r.monthPicked && !r.month && (
                <div className="stmt-monthhint" title="This amount doesn't match one month's rent — it covers more than one, so it's left untagged and the ledger applies it to the months still owed, oldest first. Pick a month to pin it to just that one.">
                  covers several months
                </div>
              )}
              {!dupe && r.mismatch && (
                <div className="stmt-mismatch">
                  {r.mismatch.escalation ? (
                    <span className="badge info" title={`This tenant's rent stepped up to ${money(r.mismatch.projected)} in ${MONTH_NAMES[r.mismatch.escalation.stepMonth - 1]}. This deposit is at the earlier ${money(r.mismatch.escalation.prevOwed)} rate — the raise simply hasn't been paid at the new amount yet, not a shortfall.`}>
                      ↗ matches the pre-raise rate — rent stepped to {money(r.mismatch.projected)} in {MONTH_NAMES[r.mismatch.escalation.stepMonth - 1]}
                    </span>
                  ) : (
                    <span className="stmt-mismatch-chip" title={`The ledger projects ${money(r.mismatch.projected)} for this month; this deposit is ${r.mismatch.delta < 0 ? 'below' : 'above'} it.`}>
                      ≠ projected {money(r.mismatch.projected)} — {r.mismatch.delta < 0 ? `short ${money(Math.abs(r.mismatch.delta))}` : `over ${money(r.mismatch.delta)}`}
                    </span>
                  )}
                  {r.mismatch.delta < 0 && onDraftLetter && (
                    <button type="button" className="ghost btn-sm" onClick={() => onDraftLetter(r)} title="Draft a letter letting the tenant know their payment came in short of the scheduled rent (often a rent adjustment) — nothing sends automatically">
                      ✉ Draft letter
                    </button>
                  )}
                </div>
              )}
            </>
          )
        )}
      </td>
      <td>
        {r.ai ? (
          <span className="badge info" title="AI suggestion — tick the checkbox to accept it">AI</span>
        ) : (
          <span className={`badge ${CONF_TONE[row.confidence] || 'info'}`} title={`Match confidence: ${row.confidence}`}>{CONF_LABEL[row.confidence] || row.confidence}</span>
        )}
        {/* Saving a line teaches its payee, so there is nothing to tick — the column
            that used to ask ("Always") only ever confused things. Say what will be
            learned, quietly, on the row it's learned from. */}
        {r.checked && payee && (r.kind === 'tenant' || r.kind.startsWith('expense_')) && (
          <div className="stmt-learn muted" title={`Saving this remembers “${payee}” and sorts it here on future statements. Change or remove it any time under Learned payees. The month is never remembered — every statement is dated from its own lines.`}>
            remembers “{payee}”
          </div>
        )}
      </td>
    </tr>
  );
}

function DupeGroup({ rows, ctx, year, closedYears, setOv, buckets, onNewBucket, payeeOf }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stmt-group">
      <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Duplicates · {rows.length} — already imported, skipped by default
      </button>
      {open && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="stmt-table">
            <HeadRow />
            <tbody>
              {rows.map((r) => <ReviewRow key={r.i} r={r} ctx={ctx} year={year} closedYears={closedYears} expenseProp={null} setOv={setOv} buckets={buckets} onNewBucket={onNewBucket} payeeOf={payeeOf} dupe />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SkippedGroup({ skipped }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="stmt-group">
      <button type="button" className="ghost" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} Skipped lines · {skipped.length} — couldn't be read as transactions
      </button>
      {open && (
        <ul className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          {skipped.map((s, i) => <li key={i}>line {s.line}: {s.reason} — <code>{String(s.raw).slice(0, 90)}</code></li>)}
        </ul>
      )}
    </div>
  );
}
