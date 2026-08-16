import { useState } from 'react';
import { useParams, Navigate, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  getCorporation,
  getProperty,
  getPropertyTotals,
  getPropertyMonthlyRoll,
  markMonthPaid,
  unmarkMonthPaid,
  markMonthPaidAllTenants,
  markMonthsPaidAllTenants,
  listStatementImports,
  listUnplacedLines,
  listDecidedLines,
  getBankTieOut,
  settleTenantBalance,
  listOtherIncome,
  resyncLeaseBilling,
  setLineDisposition,
  placeUnplacedLine,
  undoStatementImport,
  listSnapshots,
  signDocUrl,
  localDateIso,
  getLeaseSort, discardDocument,
} from '../lib/api';
import { allocatePayments, componentizeSchedule, escalationFollowThrough, escalationStepMonths, ledgerRowSummary, monthClosedForLogging, representativeMonth, snapshotCollectionSummary } from '../lib/ledger';
import { sortTenantRows } from '../lib/leaseSort';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import { useFeatures } from '../lib/features';
import FinancialsTabs from '../components/FinancialsTabs';
import StatementReview from '../components/StatementReview';
import TenantSortBar from '../components/TenantSortBar';
import ImportStatementButton, { ImportResultsStrip, StatementDropZone, settleStatementImport } from '../components/ImportStatementButton';
import LearnedPayeesPanel from '../components/LearnedPayeesPanel';
import MutationError from '../components/MutationError';
import { useConfirm } from '../components/ConfirmDialog';
import LeaseTypeChip from '../components/LeaseTypeChip';
import MonthDetailPanel from '../components/MonthDetailPanel';
import { money, money0, sf, fmtDate, fmtShortDate } from '../lib/format';
import { IGNORE_REASONS, lineCompleteness, dispositionInfo, ignoreReasonLabel } from '../lib/dispositions';
import { rentPosition, tieOutSentence } from '../lib/bankTieOut';
import { tenantStanding, settleChoicesFor } from '../lib/settle';
import { settleBillingChange } from '../lib/invalidate';
import Panel from '../components/Panel';
import { incomeCategoriesInUse, incomeCategoryLabel, customCategoryKey } from '../lib/otherIncome';
import { EXPENSE_CATEGORIES } from '../lib/expenseCategories';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
// Sentinel for "name one that isn't on the list yet" — never stored, only ever a UI branch.
const NEW_INCOME = 'income:__new__';

// The row's payment difference in one chip: across every month that has come due AND
// been paid, how far the deposits landed from the bill. Silent below 50¢ — that's
// rounding, not a difference worth a landlord's attention.
function VarianceChip({ variance }) {
  const v = round2(Number(variance) || 0);
  if (Math.abs(v) <= 0.5) return null;
  return v < 0
    ? <span className="rr-short" title="Across the months already paid, the deposits came in under what the lease billed. The estimate is what's billed all year; the year-end ⚖ Reconcile settles the difference.">short {money(Math.abs(v))}</span>
    : <span className="rr-over" title="Across the months already paid, the deposits came in over what the lease billed.">over {money(v)}</span>;
}

// A raise landed — did the money follow? The ↗ note above says the rent stepped up;
// without this the Ledger says nothing more about it, which was George's question
// (2026-08-13). Two lines, both derived by escalationFollowThrough from the same
// allocation the boxes paint from:
//   1. WHAT THE BILL'S JUMP WAS MADE OF — his "recognize what the payment increase
//      should have been on the base and see if the estimate cam and tax increased by
//      that much". The parts always sum to the jump (componentizeSchedule's invariant),
//      so this can't print a decomposition that doesn't add up.
//   2. THE VERDICT — bill vs money in, over the settled months since the step.
// `older_gap` exists because bill-vs-money-in alone misreads a tenant who was ALREADY
// underpaying: the gap looks exactly like a raise they ignored. Naming the older part
// is the difference between a true sentence and a wrong accusation.
function StepFollowUp({ step, follow }) {
  if (!step) return null;
  const monthName = MONTHS[step.month - 1];
  const jump = follow ? round2(follow.billJump) : 0;
  const parts = [];
  if (follow?.stepMonthly > 0.005) parts.push(`${money(follow.stepMonthly)} base rent`);
  if (Math.abs(follow?.camTaxMonthly || 0) > 0.005) parts.push(`${follow.camTaxMonthly < 0 ? '−' : ''}${money(Math.abs(follow.camTaxMonthly))} CAM&tax estimate`);
  if (Math.abs(follow?.roofMonthly || 0) > 0.005) parts.push(`${follow.roofMonthly < 0 ? '−' : ''}${money(Math.abs(follow.roofMonthly))} roof`);
  // A step only exists because BASE rose, so parts always leads with base when comp is
  // present. One part means nothing else moved — which is the answer to "did the CAM &
  // tax estimate go up too?" and worth saying rather than leaving to inference.
  const madeOf = parts.length > 1 ? ` — ${parts.join(' + ')}` : (parts.length === 1 ? ' — all of it base rent' : '');

  let verdict = null;
  if (follow) {
    const per = money(Math.abs(follow.shortPerMonth));
    const total = money(Math.abs(follow.shortSince));
    const n = follow.settledSince;
    const spread = `${per}/mo since ${monthName}${n > 1 ? ` (${total} over ${n} months)` : ''}`;
    if (follow.verdict === 'pending') {
      verdict = <span className="muted">nothing recorded since the raise yet</span>;
    } else if (follow.verdict === 'honored') {
      verdict = <span className="rr-step-ok" title="Every month since the raise has settled at the new bill.">✓ picked up — {n > 1 ? `every month since ${monthName}` : `${monthName}`} came in at the new rate</span>;
    } else if (follow.verdict === 'over') {
      verdict = <span className="rr-step-ok" title="Paying above the new bill — the credit shows in the Collected column.">✓ picked up — paying {per}/mo over the new bill</span>;
    } else if (follow.verdict === 'pre_raise_rate') {
      verdict = <span className="rr-step-bad" title="The gap since the step is the step itself — this tenant is still paying the pre-raise amount.">⚠ still at the pre-raise rate — short {spread}</span>;
    } else if (follow.verdict === 'older_gap') {
      verdict = <span className="rr-step-bad" title="This tenant was already paying under the bill before the raise, so the gap is not the escalation alone.">⚠ short {spread} — but {money(Math.abs(follow.shortBeforePerMonth))}/mo of that was already short before the raise</span>;
    } else {
      const got = round2(jump - follow.shortPerMonth);
      verdict = <span className="rr-step-bad" title="The cheque moved, but not by the whole increase.">⚠ picked up {money(got)} of the {money(jump)} increase — short {spread}</span>;
    }
  }
  return (
    <>
      {jump > 0.005 && (
        <div className="rr-step-note" title="What this month's bill went up by, and what that increase is made of. Only the base-rent part is the escalation.">
          the bill went up {money(jump)} in {monthName}{madeOf}
        </div>
      )}
      {verdict && <div className="rr-step-verdict">{verdict}</div>}
    </>
  );
}

// The Rent Ledger: tenants down the side, the 12 months across, PROJECTED (what the
// lease bills) vs ACTUAL (what's been collected) — the per-tenant "owes $X / owed $X"
// view George's partners asked for. Cell states derive from ONE allocation of the
// year's payments (ledger.js): tagged payments cover their own month, untagged
// (lump/partial) money pools and fills months first-to-last, so a lump payer reads
// ✓ ✓ ✓ ✓ ✓ ◐ with the rest open. Click a cell to record/undo that month; the
// trailing Collected / Owes columns come from the SAME allocation, so the figures
// and the cells can never disagree. Scoped to the shared fiscal-year selector.
export default function LedgerPage() {
  const { corpId, propId } = useParams();
  const { year } = useChrome();
  const { isOn, loading: featuresLoading } = useFeatures();
  const qc = useQueryClient();
  const askConfirm = useConfirm();

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: totals } = useQuery({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year), placeholderData: keepPreviousData });
  const rollKey = ['propertyRentRoll', propId, year];
  const { data: rows = [], isLoading } = useQuery({ queryKey: rollKey, queryFn: () => getPropertyMonthlyRoll(propId, year) });
  const { data: leaseSort = {} } = useQuery({ queryKey: ['leaseSort'], queryFn: getLeaseSort });
  usePageChrome([
    { label: 'Financials', to: '/financials' },
    { label: corp?.name || '…', to: `/financials/${corpId}` },
    { label: prop?.name || '…', to: `/financials/${corpId}/${propId}` },
    { label: 'Ledger' },
  ], true);

  const [note, setNote] = useState('');
  // Statement import: null | { fileName, accountHint, parsed, pdfLane } while reviewing.
  const [importDoc, setImportDoc] = useState(null);
  // The post-save results strip: { summary, import, fileName }.
  const [imported, setImported] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  // Naming a new other-income category on an unplaced line — the id of the line being
  // named, and the text so far.
  const [namingIncome, setNamingIncome] = useState(null);
  const [incomeDraft, setIncomeDraft] = useState('');
  // Scoped to the fiscal year the rest of the page follows, so the log resets with the
  // year instead of every statement ever imported piling into one list.
  const { data: register = [] } = useQuery({
    queryKey: ['statementImports', propId, year],
    queryFn: () => listStatementImports(propId, year),
    enabled: isOn('ledger'),
  });
  // Prior-year collection rate (from the year-close snapshot) — the quiet trend chip.
  const { data: snaps = [] } = useQuery({
    queryKey: ['snapshots', propId],
    queryFn: () => listSnapshots(propId),
    enabled: isOn('ledger'),
  });
  const prevSnap = (snaps || []).find((s) => Number(s.year) === year - 1);
  const prevCollection = prevSnap ? snapshotCollectionSummary(prevSnap) : null;

  // Slice 4a — money the statements showed that nobody has placed. Before 0076 these
  // lines produced no write and no record at all, so this figure could not exist.
  const { data: unplaced = [] } = useQuery({
    queryKey: ['unplacedLines', propId, year],
    queryFn: () => listUnplacedLines(propId, year),
    enabled: isOn('ledger'),
  });
  const unplacedTotals = lineCompleteness(unplaced);
  // The other half of the same list: what HAS been decided. Until 2026-08-13 a decided line
  // simply left the screen — 0076 stored the decision and its reason and nothing read them
  // back (George: "it disappeared … i dont know where that money went").
  const { data: decided = [] } = useQuery({
    queryKey: ['decidedLines', propId, year],
    queryFn: () => listDecidedLines(propId, year),
    enabled: isOn('ledger'),
  });
  // Slice 3 — the same lines from the third angle: not "was a decision made?" but "did the
  // money that decision promised actually reach a table?". Null when nothing has been
  // imported for the year, so the panel is absent rather than claiming a clean bill of
  // health nobody checked.
  const { data: tieOut = null } = useQuery({
    queryKey: ['bankTieOut', propId, year],
    queryFn: () => getBankTieOut(propId, year),
    enabled: isOn('ledger'),
  });
  // The receipts already recorded, read ONLY to offer back the write-in categories they
  // carry. A custom income category exists because a row uses it — derived from use, so
  // there is no list to store and nothing to clean up. Same key the Financials page uses,
  // so this is a cache hit whenever he has been there.
  const { data: incomeRows = [] } = useQuery({
    queryKey: ['otherIncome', propId, year],
    queryFn: () => listOtherIncome(propId, year),
    enabled: isOn('ledger'),
  });
  // Money in and money out stay APART here for the same reason lineCompleteness keeps them
  // apart: one netted figure lets a $5,000 deposit and a $5,000 withdrawal report "$0",
  // which reads as health on a statement where $10,000 was filed.
  const decidedTotals = (decided || []).reduce(
    (t, l) => {
      const amt = Math.abs(Number(l.amount) || 0);
      if (l.direction === 'in') t.in = round2(t.in + amt); else t.out = round2(t.out + amt);
      return t;
    },
    { in: 0, out: 0 },
  );
  // Both panels move together — a line leaves one exactly when it joins the other. The
  // tie-out reads the SAME lines from the third angle, so it moves with them or it spends
  // the rest of the session reporting money as unplaced that the landlord has just filed.
  const settleLines = () => {
    qc.invalidateQueries({ queryKey: ['unplacedLines', propId, year] });
    qc.invalidateQueries({ queryKey: ['decidedLines', propId, year] });
    qc.invalidateQueries({ queryKey: ['bankTieOut', propId, year] });
  };
  const leaveOut = useMutation({
    mutationFn: ({ id, reason }) => setLineDisposition(id, 'ignored', reason || null),
    onSuccess: settleLines,
  });
  // Put a line back where it was. ⚠ Offered for `ignored` and `transfer` ONLY, and the
  // reason is not tidiness: those two write no money — the disposition IS the record — so
  // un-deciding them is lossless. Every other disposition wrote a real other_income /
  // not-billed cam_line_items / deposit row, and setLineDisposition deliberately does NOT
  // touch money, so "undoing" one would leave that row behind and the line free to be
  // placed a second time. That is how one $20,154 line gets counted twice.
  const unplaceLine = useMutation({
    mutationFn: (id) => setLineDisposition(id, 'unclassified', null),
    onSuccess: settleLines,
  });
  // Give the line a real home from here, without re-importing the statement it came
  // from. Every destination writes either an `other_income` row or a NOT-BILLED expense
  // line, and syncCamTotal excludes the latter from cam_total — so answering the nag can
  // never move a tenant's bill or this property's NOI.
  const place = useMutation({
    // The pick encodes its own sub-destination: `income:<category>`, `deposit:<leaseId>`
    // and `expense:<category>` (a distribution is `expense:distribution`).
    mutationFn: ({ line, kind }) => placeUnplacedLine(line, {
      kind: kind.startsWith('income:') ? 'income' : kind.startsWith('deposit:') ? 'deposit' : kind.startsWith('expense:') ? 'expense' : kind,
      category: kind.startsWith('income:') ? kind.slice(7) : kind.startsWith('expense:') ? kind.slice(8) : null,
      leaseId: kind.startsWith('deposit:') ? kind.slice(8) : null,
      // ⚠ The fiscal year the landlord is looking at, as the LAST fallback behind the
      // line's own year and its transaction date. An expense row written with no year is
      // invisible in every year's figures (`listExpenseLineItems` reads the year exactly),
      // which is how a placed line could read "recorded" and reach no sheet at all.
      year,
    }),
    onSuccess: () => {
      settleLines();
      // A not-billed expense line landed: the CAM list, the bucket records that carry
      // its category, the corp-card distribution roll-up and the Financials strips all
      // read it. `camLineItems` is a prefix so every year of this property repaints.
      qc.invalidateQueries({ queryKey: ['camLineItems'] });
      qc.invalidateQueries({ queryKey: ['expenseBuckets'] });
      qc.invalidateQueries({ queryKey: ['corpDistributions'] });
      qc.invalidateQueries({ queryKey: ['otherIncome'] });
      qc.invalidateQueries({ queryKey: ['depositLines'] });
    },
  });

  // ── Slice 4: settling a year-end balance ───────────────────────────────────────────────
  //
  // ⚠ The carry-through runs on BOTH years when a balance is carried forward — the invoice on
  // next January moved too, and a set that only invalidated this year is exactly how the drift
  // this app already knows about gets created. `settleBillingChange` is the named set for "a
  // billed figure moved"; hand-rolling a list here is what CLAUDE.md §6 warns against.
  const settleUp = useMutation({
    mutationFn: ({ leaseId, choice }) => settleTenantBalance({ leaseId, propertyId: propId, year, choice, today }),
    onSuccess: (res) => {
      if (res?.refused) { setNote(res.message); return; }
      settleBillingChange(qc, { propertyId: propId, leaseId: res.standing?.lease_id, year });
      if (res.carriedTo) settleBillingChange(qc, { propertyId: propId, leaseId: res.standing?.lease_id, year: res.carriedTo });
      qc.invalidateQueries({ queryKey: ['historyEvents'] });
      setNote(res.wrote ? `${res.description}.` : `${res.standing?.label || 'That tenant'} — left open.`);
    },
  });

  // ⚠ WHAT HAPPENS TO THE MONEY, not "are you sure". The one fact a landlord cannot work out
  // for themselves is which of the four moves the YEAR'S INCOME — only the write-off does —
  // so `movesIncome` comes off the registry rather than being re-decided in this dialog.
  async function askSettle(standing, choiceKey) {
    const pick = settleChoicesFor(standing).find((c) => c.key === choiceKey && c.ok);
    if (!pick) return;
    const owed = standing.owes || standing.inCredit;
    const ok = await askConfirm({
      title: `${pick.label} — ${standing.label}?`,
      message: `${standing.owes ? `${standing.label} still owes ${money(owed)} for FY ${year}.` : `${standing.label} is ${money(owed)} ahead for FY ${year}.`}`,
      implications: [
        pick.hint,
        pick.movesIncome
          ? `This year's income falls by ${money(owed)} — the sheet already counted it as earned, so forgiving it has to take it back out.`
          : 'The year’s income does not move. Only what the tenant owes changes.',
        pick.key === 'carry'
          ? `Two rows in two years: FY ${year} is cleared and January ${year + 1} carries it. Both are needed — one alone loses the money.`
          : `It lands on the months it belongs to, never more than a month's own bill — the Ledger grid repaints as you watch.`,
        'It is logged under History, naming the tenant and the amount.',
      ],
      confirmLabel: pick.label,
      // Filing, not deleting. Red is reserved for permanent deletes — and a write-off is
      // reversible by deleting its rows on the month panel.
      tone: 'default',
    });
    if (ok) settleUp.mutate({ leaseId: standing.lease_id, choice: pick.key });
  }

  // ⚠ BOTH dropdowns commit a DB write on a single change event, and until 2026-08-13 they
  // did it with no confirm and no way back — George picked "transfer between my own
  // accounts" by accident and the line was gone. So each one asks first, and the dialog's
  // job is to answer the question he actually asked: not "are you sure" but WHAT HAPPENS TO
  // THE MONEY. Tone stays neutral — this is filing, not deleting.
  const lineLabel = (l) =>
    `${fmtShortDate(l.txn_date) || 'undated'} · ${l.description || 'this line'} · ${l.direction === 'in' ? '+' : '−'}${money(Math.abs(Number(l.amount) || 0))}`;

  async function askLeaveOut(l, reasonKey) {
    const reason = ignoreReasonLabel(reasonKey) || 'left out';
    const ok = await askConfirm({
      title: 'Leave this line out of the ledger?',
      message: `${lineLabel(l)} — recorded as: ${reason.toLowerCase()}.`,
      implications: [
        'It is NOT income and NOT an expense: no tenant’s bill moves, and it appears in no total on any page or export.',
        'The line stays on record under “Decided” below, with this reason beside it.',
        'You can put it back at any time — nothing about it is deleted.',
      ],
      confirmLabel: 'Leave it out',
      // Filing, not deleting — red is reserved for permanent deletes.
      tone: 'default',
    });
    if (ok) leaveOut.mutate({ id: l.id, reason: reasonKey });
  }

  async function askPlace(l, kind, optionText) {
    // A transfer writes nothing; every other destination writes a real row, and saying which
    // is the difference between "where did it go" and another vanishing act.
    const isTransfer = kind === 'transfer';
    const where = isTransfer
      ? 'It is neither income nor expense — the record of the move is the whole point, and it lands in no total.'
      : kind.startsWith('deposit:')
        ? 'It is recorded as the tenant’s money, held. Never income, and never credited against their rent.'
        : kind.startsWith('income:')
          ? 'It lands in Other income on the Financials page and in the Income-and-expenses workbook.'
          : 'It lands as a NOT-BILLED expense line: it shows in what the year cost you, and reaches no tenant’s CAM.';
    const ok = await askConfirm({
      title: `Record this as ${String(optionText || 'this').toLowerCase()}?`,
      message: lineLabel(l),
      implications: [
        where,
        'No tenant’s bill and no CAM total moves — nothing here can change what a tenant owes.',
        'It moves to “Decided” below, naming where it went.',
      ],
      confirmLabel: 'Record it',
      tone: 'default',
    });
    if (ok) place.mutate({ line: l, kind });
  }

  // A category the six built-ins don't cover (George, 2026-08-13). `custom:<slug>` is the
  // same write-in shape CAM buckets and tax categories use, so it needs no table and no
  // migration — `other_income.category` is free text by design (0078).
  function commitNewIncome(l) {
    const key = customCategoryKey(incomeDraft);
    setNamingIncome(null);
    setIncomeDraft('');
    // An unusable name leaves the line unplaced rather than storing a key nothing can label.
    if (key) askPlace(l, `income:${key}`, incomeCategoryLabel(key));
  }

  async function askUnplace(l) {
    const ok = await askConfirm({
      title: 'Put this line back?',
      message: `${lineLabel(l)} returns to “Money not yet placed”.`,
      implications: [
        'It starts nagging again until you decide about it.',
        'Nothing was written when it was left out, so nothing is reversed — no figure moves.',
      ],
      confirmLabel: 'Put it back',
      tone: 'default',
    });
    if (ok) unplaceLine.mutate(l.id);
  }

  // Scoped invalidation after a write settles — this property's roll + the lease-page
  // invoices/payments panels; deliberately not a blanket sweep.
  const settle = () => {
    qc.invalidateQueries({ queryKey: rollKey });
    qc.invalidateQueries({ queryKey: ['monthlyRent'] });
    qc.invalidateQueries({ queryKey: ['invoices'] });
    qc.invalidateQueries({ queryKey: ['payments'] });
  };

  // A statement import can touch OTHER properties' tenants (cross-property deposits)
  // plus this property's expenses — refresh every surface that money moved (shared
  // helper, so the Financials-page host invalidates the identical set).
  const settleImport = () => settleStatementImport(qc);

  const undoImport = useMutation({
    mutationFn: (imp) => undoStatementImport(imp),
    onSuccess: (res) => {
      setImported(null);
      setNote(res?.notes?.length ? res.notes.join(' ') : 'Import undone — its payments and expense additions were reversed.');
      settleImport();
    },
  });

  // Per-cell pending set (`${leaseId}:${m}`) so ONE click disables only its own box —
  // the whole grid stays clickable (parallel marks work), which is the speed fix.
  const [pendingCells, setPendingCells] = useState(() => new Set());
  // Which month box is open in the detail panel: { leaseId, month } or null.
  const [editing, setEditing] = useState(null);
  const cellKey = (leaseId, m) => `${leaseId}:${m}`;

  // Optimistic paint: adjust the row's raw payments (what the allocation derives from)
  // so the click repaints instantly while the write settles.
  const paint = (old, leaseId, month, action, amount) =>
    (old || []).map((r) => {
      if (r.lease_id !== leaseId) return r;
      const payments = [...(r.payments || [])];
      const byMonth = { ...r.byMonth };
      if (action === 'unmark') {
        delete byMonth[month];
        return { ...r, byMonth, payments: payments.filter((p) => Number(p.period_month) !== month) };
      }
      payments.push({ amount, period_month: month, paid_date: localDateIso() });
      byMonth[month] = { amount: (byMonth[month]?.amount || 0) + amount };
      return { ...r, byMonth, payments };
    });

  const cellMut = useMutation({
    // Every write carries a real amount (open→full owed, gap→the residual) so markMonthPaid
    // skips the schedule rebuild AND the optimistic paint moves a real figure, not undefined.
    mutationFn: ({ leaseId, month, action, amount }) =>
      action === 'unmark'
        ? unmarkMonthPaid(leaseId, year, month)
        : markMonthPaid(leaseId, propId, year, month, { amount }),
    onMutate: async ({ leaseId, month, action, amount }) => {
      setPendingCells((s) => new Set(s).add(cellKey(leaseId, month)));
      await qc.cancelQueries({ queryKey: rollKey });
      const prev = qc.getQueryData(rollKey);
      qc.setQueryData(rollKey, (old) => paint(old, leaseId, month, action, amount));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(rollKey, ctx.prev); setNote('Could not save that change — please try again.'); },
    onSettled: (_d, _e, vars) => {
      setPendingCells((s) => { const n = new Set(s); n.delete(cellKey(vars.leaseId, vars.month)); return n; });
      settle();
    },
  });
  const allMut = useMutation({
    mutationFn: (month) => markMonthPaidAllTenants(propId, year, month),
    onError: () => setNote('Could not mark all paid — please try again.'),
    onSuccess: (res, month) => {
      setNote(`Marked ${MONTHS[month - 1]} paid for ${res.paid} tenant${res.paid === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} already covered or free)` : ''}.`);
    },
    onSettled: settle,
  });
  const catchUpAll = useMutation({
    // One round-trip for every due month × every tenant (the plural bulk), not a serial loop.
    mutationFn: (months) => markMonthsPaidAllTenants(propId, year, months),
    onSuccess: (res) => setNote(res.paid ? `Recorded ${res.paid} tenant-month${res.paid === 1 ? '' : 's'} of rent.` : 'Everyone was already caught up.'),
    onError: () => setNote('Could not catch up the ledger — please try again.'),
    onSettled: settle,
  });
  const bulkBusy = allMut.isPending || catchUpAll.isPending;

  // Rebuild ONE tenant's stored invoice from the lease as it now stands. The button only
  // appears when the two have actually drifted apart (r.drift, api.js) — which is how the
  // NIGHTLY SQL rent-step sweep gets caught: it moves base_rent server-side where no JS runs,
  // so nothing here can carry the change through at the moment it happens. Showing the gap and
  // letting the landlord close it is also what he asked for — *"the user will have to
  // recalculate when they get their next months statement"* — rather than a silent rewrite of
  // a bill he has already sent.
  const rebuild = useMutation({
    mutationFn: (leaseId) => resyncLeaseBilling(leaseId, propId, year),
    onSuccess: (res) => setNote(res?.skipped === 'closed'
      ? 'That year is closed, so its bill was left exactly as it was sent.'
      : 'Rebuilt this tenant’s bill from the lease as it stands now.'),
    onError: () => setNote('Could not rebuild that bill — please try again.'),
    onSettled: settle,
  });

  // Module switched off → back to the property's Financials page.
  if (!featuresLoading && !isOn('ledger')) {
    return <Navigate to={`/financials/${corpId}/${propId}`} replace />;
  }

  const vacant = Number(totals?.vacant_sf) || 0;

  // Calendar awareness (localDateIso = the landlord's local "today", not UTC).
  const todayIso = localDateIso();
  const today = new Date(`${todayIso}T12:00:00`);
  const curY = Number(todayIso.slice(0, 4));
  const curM = Number(todayIso.slice(5, 7));
  const isCurrentFy = year === curY;
  const throughM = year < curY ? 12 : (isCurrentFy ? curM : 0);

  // Derive each row's allocation / components / summary ONCE per render, then order
  // the tenants by the shared sort preference (name / size / rent / suite).
  const tenantSort = leaseSort.tenants || {};
  const derived = sortTenantRows(
    rows.map((r) => {
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });
      const comp = componentizeSchedule({ schedule: r.schedule, factor: r.factor, camTaxAnnual: r.camTaxAnnual, roofAnnual: r.roofAnnual, camTaxByMonth: r.camTaxByMonth, roofByMonth: r.roofByMonth, adjustments: r.adjustments });
      const summary = ledgerRowSummary({ year, owedByMonth: r.schedule, allocation: alloc, today });
      const steps = escalationStepMonths({ schedule: r.schedule, comp });
      // Did the money follow the raise? Same allocation the boxes paint from, so the
      // verdict and the row's own `short $X` chip can never disagree.
      const followUp = escalationFollowThrough({ year, owedByMonth: r.schedule, allocation: alloc, steps, comp, today });
      // ⚠ The alloc and summary already derived above are HANDED IN, not re-derived. The
      // workbook's copy of this block builds its own from the same two choke points; what
      // must never happen is a third arithmetic for "what does this tenant owe" (CLAUDE.md §3),
      // because the number on this row is the number the Settle up button acts on.
      const standing = tenantStanding({ row: r, year, today, alloc, summary });
      return { r, alloc, comp, summary, steps, followUp, standing };
    }),
    { mode: tenantSort.mode, dir: tenantSort.dir, pick: (d) => d.r }
  );

  // The row the month panel is open on — resolved from the SAME derived array the grid
  // paints from, so the panel and the box it was opened from can never disagree (and it
  // repaints automatically after a post).
  const editingRow = editing ? derived.find(({ r }) => r.lease_id === editing.leaseId) : null;

  const markAll = (m) => {
    const unpaid = derived.filter(({ alloc }) => round2(alloc.owed[m - 1] - alloc.coverage[m - 1]) > 0.05).length;
    if (unpaid === 0) { setNote(`Everyone is already covered for ${MONTHS[m - 1]}.`); return; }
    if (window.confirm(`Mark ${MONTHS[m - 1]} ${year} paid for all ${unpaid} tenant${unpaid === 1 ? '' : 's'} who haven't yet?`)) {
      allMut.mutate(m);
    }
  };
  const catchUp = () => {
    if (!throughM) return;
    const months = Array.from({ length: throughM }, (_, i) => i + 1);
    if (window.confirm(`Mark rent paid for every tenant through ${MONTHS[throughM - 1]} ${year} (only what they still owe)?`)) {
      catchUpAll.mutate(months);
    }
  };
  const behindTotal = derived.reduce((acc, { summary }) => acc + summary.monthsBehind, 0);
  const totalCollected = derived.reduce((s, { summary }) => s + summary.collected, 0);
  const totalProjected = derived.reduce((s, { summary }) => s + summary.projected, 0);
  const totalBilled = derived.reduce((s, { summary }) => s + summary.billed, 0);
  // ⚠ The tie-out's rent block comes from `rentPosition` over the SAME roll this grid is
  // painted from, not from `totalBilled` / `totalCollected` above — because the workbook's
  // copy of this block has no `derived` to read and would otherwise need a second
  // definition of "billed for the year". One function, both surfaces (CLAUDE.md §3). They
  // agree to the cent: `summary.billed` sums the same `owed` array `r.annual` does.
  const rentPos = rentPosition(rows);
  const tieOutWithRent = tieOut ? { ...tieOut, rent: rentPos } : null;
  const totalVariance = round2(derived.reduce((s, { summary }) => s + summary.variance, 0));
  const totalCredit = derived.reduce((s, { summary }) => s + (summary.credit > 0.05 ? summary.credit : 0), 0);
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 100) : null);

  if (importDoc) {
    return (
      <div>
        <div className="page-head">
          <div>
            <h1>{prop?.name || '…'}</h1>
            <div className="muted">Rent ledger · FY {year} — reviewing {importDoc.fileName}</div>
          </div>
        </div>
        <FinancialsTabs corpId={corpId} propId={propId} />
        <div className="panel">
          <StatementReview
            propertyId={propId}
            year={year}
            fileName={importDoc.fileName}
            accountHint={importDoc.accountHint}
            parsed={importDoc.parsed}
            storagePath={importDoc.storagePath}
            pdfLane={importDoc.pdfLane}
            onCancel={() => { const p = importDoc.storagePath; setImportDoc(null); if (p) discardDocument(p).catch(() => {}); }}
            onSaved={(res) => {
              setImportDoc(null);
              setImported({ ...res, fileName: importDoc.fileName });
              settleImport();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{prop?.name || '…'}</h1>
          <div className="muted">Rent ledger · FY {year} — projected vs collected, month by month</div>
        </div>
      </div>

      <FinancialsTabs corpId={corpId} propId={propId} />

      {/* The whole ledger is the drop target — a statement can be dragged anywhere
          onto it, not just onto the button. */}
      <StatementDropZone className="panel" onReady={setImportDoc}>
        <div className="panel-head">
          <strong>Ledger · FY {year}</strong>
          <span className="row" style={{ gap: 8 }}>
            {throughM > 0 && behindTotal > 0 && (
              <button type="button" className="ghost" disabled={bulkBusy} onClick={catchUp} title={`Record every unpaid month that has come due, for all tenants, through ${MONTHS[throughM - 1]}`}>
                {catchUpAll.isPending ? 'Recording…' : `✓ Mark everyone paid through ${MONTHS[throughM - 1]}`}
              </button>
            )}
            <ImportStatementButton onReady={setImportDoc} />
          </span>
        </div>
        {/* The key is built from REAL .rr-cell elements wearing the live classes, so it
            can never drift from what the grid actually paints. */}
        <div className="rr-key">
          <span className="rr-key-label">Key</span>
          <span className="rr-key-item"><span className="rr-cell paid">✓<span className="rr-amt">5,324</span></span> paid in full</span>
          <span className="rr-key-item"><span className="rr-cell paid">✓<span className="rr-amt under">5,025</span></span> paid under the bill</span>
          <span className="rr-key-item"><span className="rr-cell paid pool">✓</span> covered by a lump</span>
          <span className="rr-key-item"><span className="rr-cell partial">◐</span> partly covered</span>
          <span className="rr-key-item"><span className="rr-cell late">—</span> month ended, unpaid</span>
          <span className="rr-key-item"><span className="rr-cell recv">↓</span> received, not billed</span>
          <span className="rr-key-item"><span className="rr-cell rr-step">▌</span> rent stepped up</span>
          <span className="rr-key-note">Click a box to record that month, or undo it. A payment with no month recorded fills the earliest months first.</span>
          {prevCollection?.rate != null && (
            <Link to={`/history/${corpId}/${propId}`} className="rr-key-note rr-tenant" title="From the closed year's snapshot — open History for the trend">FY {year - 1} collection rate: {Math.round(prevCollection.rate * 100)}%</Link>
          )}
        </div>
        {note && <p className="badge good" style={{ marginBottom: 10 }}>{note}</p>}
        {rows.length > 1 && <TenantSortBar />}
        {isLoading ? <p className="muted">Loading…</p> : (!rows.length && vacant <= 0) ? (
          <p className="empty-line muted">No tenants with rent on file for FY {year}.</p>
        ) : (
        <div className="table-wrap">
          <table className="rent-roll">
            <thead>
              <tr>
                <th>Tenant</th>
                {MONTHS.map((ml, i) => (
                  <th key={ml} className={isCurrentFy && i + 1 === curM ? 'rr-current' : undefined}>
                    <div className="rr-mhead">
                      <span>{ml}</span>
                      {i + 1 <= throughM && (
                        <button type="button" className="ghost rr-all" disabled={bulkBusy} onClick={() => markAll(i + 1)} title={`Mark ${ml} paid for all tenants`}>✓ all</button>
                      )}
                    </div>
                  </th>
                ))}
                <th className="rr-owes">Collected</th>
              </tr>
            </thead>
            <tbody>
              {derived.map(({ r, alloc, comp, summary, steps, followUp, standing }) => {
                const heldOver = (r.lease_termination_date && r.lease_termination_date < todayIso) || r.is_active === false;
                const rate = pct(summary.collected, summary.projected);
                const stepSet = new Set(steps.map((s) => s.month));
                // Identity sub-line: show the tenant's CURRENT monthly, not a year-average.
                // On a stepped tenant the average (r.monthly = annual ÷ months) equals no box
                // and doesn't match its own base·CAM&tax breakdown — so read the representative
                // month's owed, which ties the headline, its breakdown, and that month's box.
                const repM = representativeMonth({ owedByMonth: alloc.owed, schedule: r.schedule, isCurrentFy, curMonth: curM });
                const rep = repM ? comp[repM] : null;
                const repMonthly = rep ? round2(alloc.owed[repM - 1]) : r.monthly;
                return (
                  <tr key={r.lease_id}>
                    <td>
                      <Link to={`/leases/${corpId}/${propId}/${r.lease_id}`} className="rr-tenant">{r.tenant_name}</Link>
                      {/* How this tenant's expenses are recovered — the same chip the
                          per-tenant breakdown shows, so the two surfaces agree. It's what
                          explains why a gross row's base is lower than its lease rent. */}
                      <LeaseTypeChip gross={!!r.gross} />
                      {heldOver && (
                        <div>
                          <span className="badge warn" style={{ marginTop: 3 }} title="This lease has expired but the tenant is being held over — rent still collects until you remove or extend the lease.">
                            Expired — held over{r.is_active === false ? ' · needs extension' : ''}
                          </span>
                        </div>
                      )}
                      <div className="rr-split">
                        {money(repMonthly)}/mo{rep ? ` = ${money(rep.base)} base · ${money(rep.camTax)} CAM&tax${rep.roof > 0 ? ` · ${money(rep.roof)} roof` : ''}` : ''}{r.owedMonths < 12 ? ` · ${r.owedMonths} mo` : ''}
                      </div>
                      {steps.length > 0 && (
                        <>
                          <div className="rr-step-note" title="This tenant's base rent stepped up mid-year on a scheduled escalation — the two different monthly amounts are both correct.">
                            ↗ rent raised to {money(steps[0].owed)}/mo in {MONTHS[steps[0].month - 1]}
                          </div>
                          {/* …and whether the money followed. Judged from the SAME step
                              the note above names — on the rare twice-stepped lease the
                              two lines must talk about one month, or the row contradicts
                              itself. escalationFollowThrough returns every step, so a
                              later round can refine which one without touching it. */}
                          <StepFollowUp step={steps[0]} follow={followUp?.[0]} />
                        </>
                      )}
                    </td>
                    {MONTHS.map((ml, i) => {
                      const m = i + 1;
                      const s = r.schedule?.[m];
                      const c = comp[m];
                      const adjM = round2(Number(c?.adj) || 0);
                      // Any cell carrying a charge or a credit says so under its figure.
                      const adjChip = Math.abs(adjM) > 0.005
                        ? <span className={`rr-adj${adjM < 0 ? ' credit' : ''}`}>{adjM < 0 ? '−' : '+'}{money0(Math.abs(adjM))}</span>
                        : null;
                      const open = () => setEditing({ leaseId: r.lease_id, month: m });
                      const owedM = alloc.owed[i];
                      const state = alloc.states[i];
                      const covered = alloc.coverage[i];
                      const settledM = alloc.settled[i];
                      const receivedM = alloc.received[i];
                      const pending = pendingCells.has(cellKey(r.lease_id, m));
                      // A scheduled rent escalation lands ON this month (base stepped up vs
                      // the prior month) — mark it so the higher amount from here reads as
                      // the intended raise. outsideTerm/owed<=0 months can't be steps.
                      const isStep = stepSet.has(m);
                      const stepCls = isStep ? ' rr-step' : '';
                      const stepTip = isStep ? '↗ Scheduled rent escalation — base rent stepped up this month; the higher amount from here on is the raise, not an error. ' : '';
                      // Money recorded FOR a month the lease bills nothing for (a tenant
                      // whose lease starts later in the year, an abated month). The tag
                      // holds — it renders before the out-of-term / abated cells, which
                      // would otherwise print "—" over a real deposit and leave the money
                      // to drift onto whatever month the lease does bill.
                      if (state === 'unbilled') {
                        return (
                          <td key={m}>
                            <button type="button" className="rr-cell recv" disabled={pending} onClick={open}
                              title={`${ml}: ${money(receivedM)} received — this lease bills nothing for ${ml}, so it settles no charge and isn't counted as collected rent. Click to open the month.`}>
                              ↓<span className="rr-amt">{money0(receivedM)}</span>{adjChip}
                            </button>
                          </td>
                        );
                      }
                      if (s?.outsideTerm && !(owedM > 0)) {
                        return <td key={m}><button type="button" className="rr-cell outside" onClick={open} title={`${ml}: before this lease began — click to open the month`}>—</button></td>;
                      }
                      // ⚠ A MONTH CAN NOW OWE NOTHING FOR A SECOND REASON, and calling both of
                      // them "abated" states the wrong one. An abatement is a rent-free period
                      // the LEASE grants; a settlement (Slice 4) is money the landlord decided
                      // not to collect, or moved into another year. Same empty month, entirely
                      // different fact — and the second is a decision somebody made, which this
                      // tooltip is the only place to say. `adjM` is the month's own signed
                      // adjustment, already in hand above.
                      if (owedM <= 0) {
                        const forgiven = adjM < -0.005 && !s?.abated;
                        return (
                          <td key={m}>
                            <button type="button" className={`rr-cell ${forgiven ? 'settled-off' : 'abated'}`} onClick={open}
                              title={forgiven
                                ? `${ml}: ${money(Math.abs(adjM))} credited — this month was settled, not billed. Click to open the month and see which entry did it.`
                                : `${ml}: base rent abated — nothing due · click to open the month`}>
                              {forgiven ? '⌫' : 'F'}
                            </button>
                          </td>
                        );
                      }
                      const parts = c ? `${money(c.base)} base · ${money(c.camTax)} CAM&tax${c.roof > 0 ? ` · ${money(c.roof)} roof` : ''}${Math.abs(adjM) > 0.005 ? ` · ${adjM < 0 ? '−' : '+'}${money(Math.abs(adjM))} adjustment` : ''}` : '';
                      const monthLine = `${ml}: ${money(owedM)} owed (${parts})${s?.abated ? ' — base rent abated' : ''}`;
                      const started = year < curY || (isCurrentFy && m <= curM);
                      if (state === 'covered') {
                        // A TAGGED month is settled — "paid = paid". It reads ✓ whatever the amount;
                        // when what came in differs from the projection, show that received figure.
                        if (settledM) {
                          const tagCount = (r.payments || []).filter((p) => Number(p.period_month) === m).length;
                          const diff = round2(receivedM - owedM);
                          // "paid = paid" stands: the box stays forest ✓ and stays clickable. Only
                          // the FIGURE carries the difference — gold when the deposit came in under
                          // the bill, a + when it came in over. That's the whole signal George
                          // asked to be able to read at a glance, and it costs the cell nothing.
                          const off = Math.abs(diff) > 0.5;
                          const amtCls = `rr-amt${off ? (diff < 0 ? ' under' : ' over') : ''}`;
                          const amtText = `${off && diff > 0 ? '+' : ''}${money0(receivedM)}`;
                          const diffTip = off
                            ? ` — ${diff < 0 ? `${money(Math.abs(diff))} under` : `${money(diff)} over`} the ${money(owedM)} billed`
                            : '';
                          // Recorded across MORE than one same-month payment: undoing would delete
                          // them all, so it's inert here and managed on the lease's Invoices & payments.
                          // A settled month opens the month panel — where the base/CAM&tax
                          // split, every payment on it, and the two ways to close a
                          // difference (record the money, or say the bill itself was
                          // different) all live. George, 2026-08-03: "make the ledger
                          // clickable per month to go in and edit to show the differences."
                          // Undo moved inside the panel; several same-month payments are
                          // no longer inert (the panel lists them all).
                          return (
                            <td key={m}>
                              <button type="button" className={`rr-cell paid${s?.abated ? ' abated' : ''}${stepCls}`} disabled={pending}
                                onClick={open}
                                title={`${stepTip}${ml} paid — received ${money(receivedM)}${diffTip}${tagCount > 1 ? ` across ${tagCount} payments` : ''} · click to open the month`}>
                                ✓<span className={amtCls}>{amtText}</span>{adjChip}
                              </button>
                            </td>
                          );
                        }
                        // Covered by an untagged lump. Show the amount it drew and say a lump paid it.
                        return (
                          <td key={m}>
                            <button type="button" className={`rr-cell paid pool${stepCls}`} disabled={pending} onClick={open}
                              title={`${stepTip}${monthLine} — ${money(receivedM)} drawn from a lump payment · click to open the month`}>
                              ✓<span className="rr-amt">{money0(receivedM)}</span>{adjChip}
                            </button>
                          </td>
                        );
                      }
                      if (state === 'partial') {
                        // Part-covered by a lump. Opens the month, where "Record $X received"
                        // closes the gap in one click and an adjustment says the bill was different.
                        const gap = round2(owedM - covered);
                        return (
                          <td key={m}>
                            <button type="button" className={`rr-cell partial${stepCls}`} disabled={pending} onClick={open}
                              title={`${stepTip}${monthLine} — ${money(covered)} covered by a lump payment · click to open the month and record the remaining ${money(gap)}`}>◐{adjChip}</button>
                          </td>
                        );
                      }
                      // An OPEN month keeps its one-click mark-paid — George's call: only a
                      // month with money on it opens the panel. (Shift/right-click isn't a
                      // discoverable affordance, so the panel is reached from any settled
                      // month and its ◀ ▶ switcher walks to this one.)
                      // ⚠ OVERDUE needs the month to have ENDED, not merely started (George,
                      // 2026-08-13). The bank statement that would prove August was paid does
                      // not exist until August does, so painting the running month gold
                      // accuses a tenant of something nobody can know yet. Same rule and same
                      // function as `monthsBehind` and the two dashboard reminders. The cell
                      // stays clickable and still says the month is due — only the alarm waits.
                      const late = started && monthClosedForLogging(year, m, today, 0);
                      return (
                        <td key={m}>
                          <button type="button" className={`rr-cell${late ? ' late' : ''}${s?.abated ? ' abated' : ''}${stepCls}`} disabled={pending}
                            onClick={() => cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'mark', amount: round2(owedM) })}
                            title={`${stepTip}${late ? 'Overdue — mark' : started ? 'Due this month — mark' : 'Mark'} ${monthLine.replace(`${ml}: `, `${ml} paid: `)}`}>—{adjChip}</button>
                        </td>
                      );
                    })}
                    <td className="rr-owes">
                      <div className="rr-collected"><strong>{money(summary.collected)}</strong> <span className="muted">of {money(summary.billed)} billed</span></div>
                      <div className="rr-progress"><span style={{ width: `${Math.min(100, rate ?? 0)}%` }} /></div>
                      <div className="rr-collected-sub">
                        <span className="muted">{rate != null ? `${rate}%` : '—'}</span>
                        <VarianceChip variance={summary.variance} />
                        {summary.credit > 0.05 && <span className="rr-credit" title="Collected more than projected — owed back to the tenant">credit {money(summary.credit)}</span>}
                        {summary.monthsBehind > 0 && <span className="rr-behind" title="Months that have ENDED with nothing collected. The month still running is never counted — its bank statement hasn't arrived yet.">{summary.monthsBehind} mo behind</span>}
                      </div>
                      {/* The stored bill and the lease no longer agree. Nothing here guesses
                          why — a rent step that came due overnight, an expense figure that
                          moved — it just says so and offers to close the gap. */}
                      {!!r.drift && (
                        <div className="rr-drift">
                          <span title={`This bill was built at ${money(r.invoiceTotal)}. The lease now says ${money(summary.billed)} for ${year}.`}>
                            bill {r.drift > 0 ? 'behind' : 'ahead'} by <strong>{money(Math.abs(r.drift))}</strong>
                          </span>
                          <button type="button" className="ghost btn-sm" disabled={rebuild.isPending}
                            onClick={() => rebuild.mutate(r.lease_id)}>Rebuild</button>
                        </div>
                      )}
                      {/* ⚠ Slice 4 — the balance finally has an EXIT. Until now the Ledger could
                          say a tenant was $4,150 short and offer nothing to do about it: the
                          only instrument was a credit capped at one month's bill, so a year's
                          arrears could not be expressed at all. The button appears only on a
                          row with a real balance, and states which way it runs. */}
                      {!standing.settled && (
                        <div className="rr-drift">
                          <span title="What this tenant still owes for the year, or is ahead by — counting only the months that have come due.">
                            {standing.owes ? 'owes' : 'in credit'} <strong>{money(standing.owes || standing.inCredit)}</strong>
                          </span>
                          {/* The same shape as the unplaced panel's "Record as…" — a pick that
                              confirms before it writes. Leaving it open needs no entry: it is
                              what happens when nothing is chosen. */}
                          <select
                            className="text-input" style={{ maxWidth: 150, fontSize: 11 }}
                            value="" disabled={settleUp.isPending}
                            onChange={(e) => { if (e.target.value) askSettle(standing, e.target.value); }}
                            title="Close this balance out — leave it open, write it off, carry it into next January, or record a refund."
                          >
                            <option value="">Settle up…</option>
                            {settleChoicesFor(standing).filter((c) => c.ok && c.key !== 'leave').map((c) => (
                              <option key={c.key} value={c.key}>{c.label}</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
              {vacant > 0 && (
                <tr className="rr-vacant">
                  <td>
                    <span className="muted">Vacant space</span>
                    <div className="rr-split">{sf(vacant)} · nothing to collect</div>
                  </td>
                  {MONTHS.map((ml) => (
                    <td key={ml}><span className="rr-cell vacant" title={`${ml}: unleased space — no rent`}>—</span></td>
                  ))}
                  <td className="rr-owes muted">—</td>
                </tr>
              )}
              {derived.length > 1 && (
                <tr className="rr-totals">
                  <td className="muted">All tenants</td>
                  <td colSpan={12} />
                  <td className="rr-owes">
                    <div className="rr-collected"><strong>{money(totalCollected)}</strong> <span className="muted">of {money(totalBilled)} billed</span></div>
                    <div className="rr-progress"><span style={{ width: `${Math.min(100, pct(totalCollected, totalProjected) ?? 0)}%` }} /></div>
                    <div className="rr-collected-sub">
                      <span className="muted">{pct(totalCollected, totalProjected) != null ? `${pct(totalCollected, totalProjected)}%` : '—'}</span>
                      <VarianceChip variance={totalVariance} />
                      {totalCredit > 0.05 && <span className="rr-credit">credit {money(totalCredit)}</span>}
                      {behindTotal > 0 && <span className="rr-behind">{behindTotal} mo behind</span>}
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        )}

        <ImportResultsStrip
          imported={imported}
          undoPending={undoImport.isPending}
          onUndo={() => undoImport.mutate(imported.import)}
          onDismiss={() => setImported(null)}
        />
        <MutationError of={[undoImport]} />

        {/* Slice 4a — money not yet placed. Every line a statement showed is on record
            now (0076), so this is money the bank moved that no figure in Amlak counts
            yet. It nags on purpose and it is never silently absorbed: money IN is
            called out separately because an unplaced deposit may be rent that should
            have settled a month, which makes a tenant read short on the grid above. */}
        {unplaced.length > 0 && (
          <div className="note-msg warn" style={{ marginTop: 14 }}>
            <strong>Money not yet placed — {unplaced.length} line{unplaced.length === 1 ? '' : 's'}</strong>
            {unplacedTotals.unplacedIn > 0 && <> · {money(unplacedTotals.unplacedIn)} in</>}
            {unplacedTotals.unplacedOut > 0 && <> · {money(unplacedTotals.unplacedOut)} out</>}
            <div className="muted" style={{ fontSize: 11, marginTop: 4, marginBottom: 8 }}>
              Your statements showed these and nothing has been decided about them.
              {unplacedTotals.unplacedIn > 0 && ' Any of the money in that is rent should be recorded against a tenant — re-import that statement to place it.'}
              {' '}Or leave one out for good, and say why.
            </div>
            <table style={{ minWidth: 0 }}>
              <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th></th></tr></thead>
              <tbody>
                {unplaced.map((l) => (
                  <tr key={l.id}>
                    <td>{fmtShortDate(l.txn_date) || '—'}</td>
                    <td style={{ fontSize: 12 }}>{l.description || '—'}</td>
                    <td className="num">{l.direction === 'in' ? '+' : '−'}{money(Math.abs(Number(l.amount) || 0))}</td>
                    <td className="num">
                      {/* The nag is answerable, not just silenceable — these are the
                          homes that make the panel a work-list rather than a complaint. */}
                      {namingIncome === l.id ? (
                        /* Naming a category the list doesn't have yet. Inline rather than a
                           modal: the row's date, description and amount are the context for
                           what to call it, and a dialog would cover them. */
                        <div className="row" style={{ gap: 6, alignItems: 'center', justifyContent: 'flex-end', flexWrap: 'wrap', marginBottom: 4 }}>
                          <input className="text-input" style={{ maxWidth: 150, fontSize: 11 }} autoFocus
                            placeholder="Name the category" value={incomeDraft}
                            onChange={(e) => setIncomeDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') { e.preventDefault(); commitNewIncome(l); }
                              if (e.key === 'Escape') { setNamingIncome(null); setIncomeDraft(''); }
                            }} />
                          <button type="button" className="secondary btn-sm" disabled={!incomeDraft.trim()} onClick={() => commitNewIncome(l)}>Use it</button>
                          <button type="button" className="ghost btn-sm" onClick={() => { setNamingIncome(null); setIncomeDraft(''); }}>Cancel</button>
                        </div>
                      ) : null}
                      <select
                        className="text-input" style={{ maxWidth: 210, fontSize: 11, marginBottom: 4 }}
                        value=""
                        disabled={place.isPending}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) return;
                          if (v === NEW_INCOME) { setNamingIncome(l.id); setIncomeDraft(''); return; }
                          askPlace(l, v, e.target.selectedOptions[0]?.text);
                        }}
                        title="Record this line where it belongs. None of these touch a tenant's bill or this property's expenses."
                      >
                        <option value="">Record as…</option>
                        {/* Money OUT lands as a not-billed expense line carrying the
                            category chosen here — `distribution` marks it as the
                            landlord's own money and keeps it out of every expense
                            subtotal. Money IN carries an income category; a deposit
                            carries the tenant it belongs to, because reconciling it
                            against the lease is the whole point of recording it. */}
                        {l.direction !== 'in' && (
                          <optgroup label="Not billed to tenants">
                            <option value="expense:distribution">Owner distribution — money you took out</option>
                            {EXPENSE_CATEGORIES.filter((c) => !c.ownerCapital).map((c) => (
                              <option key={c.key} value={`expense:${c.key}`}>{c.label}</option>
                            ))}
                          </optgroup>
                        )}
                        {l.direction === 'in' && (
                          <optgroup label="Other income — not rent">
                            {incomeCategoriesInUse(incomeRows).map((c) => (
                              <option key={c.key} value={`income:${c.key}`}>{c.label}</option>
                            ))}
                            <option value={NEW_INCOME}>＋ New category…</option>
                          </optgroup>
                        )}
                        {/* ⚠ `derived` holds { r, alloc, comp, summary, … } — the TENANT is
                            `r`, not the entry. Reading `t.lease_id` off the wrapper gave every
                            option `key={undefined}` and `value="deposit:undefined"` with a
                            blank label: an optgroup of empty rows that, if picked, would have
                            filed a deposit against the string "undefined". It announced itself
                            for weeks as React's "unique key" warning on this page, which is
                            invisible in a production build — the reason it survived. */}
                        {l.direction === 'in' && derived.length > 0 && (
                          <optgroup label="Security deposit from…">
                            {derived.map(({ r }) => (
                              <option key={r.lease_id} value={`deposit:${r.lease_id}`}>{r.tenant_name}</option>
                            ))}
                          </optgroup>
                        )}
                        <option value="transfer">Transfer between my own accounts</option>
                      </select>
                      <select
                        className="text-input" style={{ maxWidth: 210, fontSize: 11 }}
                        value=""
                        disabled={leaveOut.isPending}
                        onChange={(e) => { if (e.target.value) askLeaveOut(l, e.target.value); }}
                        title="Leave this line out of the ledger, with the reason recorded against it. It stays on record under Decided below."
                      >
                        <option value="">Leave it out…</option>
                        {IGNORE_REASONS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <MutationError of={[leaveOut, place]} />
          </div>
        )}

        {/* …and where every decided line went. 0076 has stored the decision and its reason
            since it shipped, and its own comment promised "the UI offers the reasons after
            the fact" — nothing ever read them back, so a filed line simply left the screen
            (George, 2026-08-13: "it disappeared … i dont know where that money went"). This
            is that read path. Shut by default via Panel: it is a record to consult, not a
            work-list, and its summary states the total while folded. */}
        {decided.length > 0 && (
          <Panel
            id="ledger.decided"
            defaultOpen={false}
            title={`Decided — ${decided.length} line${decided.length === 1 ? '' : 's'}`}
            summary={`${money(decidedTotals.in)} in · ${money(decidedTotals.out)} out`}
            hint="Every statement line you have already filed, and what you filed it as."
          >
            <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.55, margin: '0 0 10px' }}>
              A <strong>transfer</strong> or a line <strong>left out</strong> is counted nowhere on purpose —
              not in a total, not on a statement, not in an export. The record that you decided it is the point,
              and it lives here. Anything else names the figure it landed in, and is edited there rather than undone here.
            </p>
            <table style={{ minWidth: 0 }}>
              <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th>Recorded as</th><th></th></tr></thead>
              <tbody>
                {decided.map((l) => {
                  const info = dispositionInfo(l.disposition);
                  const why = l.disposition === 'ignored' ? ignoreReasonLabel(l.ignore_reason) : null;
                  // ⚠ Undo for the two dispositions that wrote NO money. Everything else
                  // produced a real row and setLineDisposition never touches money, so
                  // "undoing" one would orphan that row and free the line to be placed a
                  // second time — the same dollar, counted twice.
                  const reversible = l.disposition === 'ignored' || l.disposition === 'transfer';
                  return (
                    <tr key={l.id}>
                      <td>{fmtShortDate(l.txn_date) || '—'}</td>
                      <td style={{ fontSize: 12 }}>{l.description || '—'}</td>
                      <td className="num">{l.direction === 'in' ? '+' : '−'}{money(Math.abs(Number(l.amount) || 0))}</td>
                      <td style={{ fontSize: 12 }} title={info.hint}>
                        {info.label}{why ? <span className="muted"> — {why.toLowerCase()}</span> : null}
                      </td>
                      <td className="num">
                        {reversible ? (
                          <button type="button" className="ghost btn-sm" disabled={unplaceLine.isPending}
                            onClick={() => askUnplace(l)}>↩ Put it back</button>
                        ) : (
                          <span className="muted" style={{ fontSize: 11 }} title="This one wrote a real record. Change it where that record lives, so the figure and the line can't disagree.">recorded</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <MutationError of={[unplaceLine]} />
          </Panel>
        )}

        {/* ── The bank tie-out ────────────────────────────────────────────────────────
            The third reader of the same lines, and the only one that asks whether the
            money they promised actually landed. "38 of 38 lines placed ✓" counts
            DECISIONS; this counts dollars, against the payments / expense / income tables
            themselves. Shut by default and stating its bottom line while folded, per
            Panel's own rule — a landlord opens it when something is wrong, and the
            summary is how they find out that it is. */}
        {tieOut && (
          <Panel
            id="ledger.tieout"
            defaultOpen={false}
            title="Bank tie-out"
            summary={tieOutSentence(tieOutWithRent)}
            hint="Every line on the statements you imported, against the rows they produced in your books."
          >
            <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.55, margin: '0 0 10px' }}>
              The left column is what the statements showed. The right is read from your <strong>payments,
              expenses and other-income rows themselves</strong> — never from the lines, because a check
              derived from the list it is checking balances no matter what went wrong. Money in and money
              out are never netted against each other.
            </p>
            {[['Money in on your statements', tieOut.in], ['Money out on your statements', tieOut.out]].map(([title, s]) => (
              <table key={title} style={{ minWidth: 0, marginBottom: 10 }}>
                <thead>
                  <tr>
                    <th>{title}</th>
                    <th className="num">On the statement</th>
                    <th className="num">In your books</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {s.rows.map((r) => {
                    const off = Math.abs(r.diff) > 0.005;
                    const attention = off || (r.unplaced && r.statement > 0.005) || r.unknown;
                    return (
                      <tr key={r.key} style={attention ? { background: 'var(--gold-soft)' } : undefined}>
                        <td>{r.label}{r.count ? <span className="muted" style={{ fontSize: 11 }}> · {r.count} line{r.count === 1 ? '' : 's'}</span> : null}</td>
                        <td className="num">{money(r.statement)}</td>
                        <td className="num">{r.books == null ? <span className="muted">—</span> : money(r.books)}</td>
                        <td style={{ fontSize: 11.5 }} className="muted">
                          {r.booksLabel ? `${r.booksLabel}${off ? ` · ${money(Math.abs(r.diff))} ${r.diff > 0 ? 'missing' : 'extra'}` : ' ✓'}` : r.nowhere}
                        </td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td><strong>Total</strong></td>
                    <td className="num"><strong>{money(s.statementTotal)}</strong></td>
                    <td></td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            ))}

            {/* ⚠ Rent gets its own heading saying it does NOT tie. Cash against billed
                differs by arrears or prepayment on every property there has ever been;
                printed among the comparisons it reads as a fault and teaches him that this
                panel cries wolf. */}
            <table style={{ minWidth: 0, marginBottom: 10 }}>
              <thead><tr><th>Rent is a reconciling item, not a tie</th><th className="num">Amount</th><th></th></tr></thead>
              <tbody>
                <tr><td>Billed to tenants this year</td><td className="num">{money(rentPos.billed)}</td><td className="muted" style={{ fontSize: 11.5 }}>every month of every lease’s schedule</td></tr>
                <tr><td>Received this year</td><td className="num">{money(rentPos.received)}</td><td className="muted" style={{ fontSize: 11.5 }}>every payment recorded, however it arrived</td></tr>
                <tr>
                  <td><strong>{rentPos.behind >= 0 ? 'Still owed' : 'Paid ahead'}</strong></td>
                  <td className="num"><strong>{money(Math.abs(rentPos.behind))}</strong></td>
                  <td className="muted" style={{ fontSize: 11.5 }}>
                    {rentPos.behind >= 0 ? 'the grid above names it tenant by tenant' : 'tenants are ahead of their bills'}
                  </td>
                </tr>
              </tbody>
            </table>

            {tieOut.handEntered && (tieOut.handEntered.expenses > 0.005 || tieOut.handEntered.income > 0.005) && (
              <p className="muted" style={{ fontSize: 11.5, lineHeight: 1.55, margin: '0 0 10px' }}>
                Not part of the comparison: {money(tieOut.handEntered.expenses)} of expenses and{' '}
                {money(tieOut.handEntered.income)} of other income are on the books with no imported statement
                behind them — typed in by hand, or paid from an account you haven’t imported. Real money, just
                not something a bank line can confirm.
              </p>
            )}

            {tieOut.differences.length > 0 ? (
              <div className="export-flags">
                {tieOut.differences.map((d, i) => <div className="export-flag" key={i}>{d}</div>)}
              </div>
            ) : (
              <p className="note-msg good" style={{ marginTop: 0 }}>
                Every line on these statements reaches the figure it was filed as. ✓
              </p>
            )}

            {/* Said here, not assumed. A tie-out that balances is easily read as "the books
                are right" — it says the two records agree, and they can agree on the same
                wrong number. */}
            <p className="muted" style={{ fontSize: 11, lineHeight: 1.55, marginBottom: 0 }}>
              What this cannot catch: a line transcribed with the wrong amount (both sides carry the same wrong
              number) · money that never touched the account you imported · a line filed under the wrong
              heading — it ties, in the wrong bucket.
            </p>
          </Panel>
        )}

        {register.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button type="button" className="ghost" onClick={() => setShowRegister((v) => !v)}>
              {showRegister ? '▾' : '▸'} Imported statements ({register.length}) — {showRegister ? 'hide' : 'show'}
            </button>
            <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>FY {year}</span>
            {showRegister && (
              <table style={{ minWidth: 0, marginTop: 8 }}>
                <thead><tr><th>File</th><th>Account</th><th>Imported</th><th className="num">Payments</th><th className="num">Expenses</th><th></th></tr></thead>
                <tbody>
                  {register.map((imp) => {
                    const applied = imp.applied || [];
                    const pays = applied.filter((a) => a.kind === 'payment');
                    // Explicit expense kinds only — 'rule' records (auto-learned payees) also
                    // ride in `applied` but aren't expenses, so they mustn't be counted here.
                    const exps = applied.filter((a) => a.kind === 'cam' || a.kind === 'tax_item' || a.kind === 'tax' || a.kind === 'roof');
                    return (
                      <tr key={imp.id}>
                        <td>{imp.file_name || '—'}</td>
                        <td>{imp.account_hint || '—'}</td>
                        <td>{fmtDate(imp.created_at)}</td>
                        <td className="num">{pays.length} · {money(pays.reduce((s, a) => s + Number(a.amount || 0), 0))}</td>
                        <td className="num">{exps.length} · {money(exps.reduce((s, a) => s + Number(a.amount || 0), 0))}</td>
                        <td className="num">
                          {imp.storage_path && (
                            <button type="button" className="ghost btn-sm" title="Open the statement file this came from"
                              onClick={async () => {
                                const url = await signDocUrl(imp.storage_path).catch(() => null);
                                if (url) window.open(url, '_blank', 'noopener');
                                else setNote('That statement file is no longer available.');
                              }}>
                              Open
                            </button>
                          )}
                          <button type="button" className="ghost btn-sm" disabled={undoImport.isPending}
                            onClick={async () => {
                              if (await askConfirm({
                                title: 'Undo statement import?',
                                message: `Undo the import of ${imp.file_name || 'this statement'}?`,
                                implications: [
                                  'Reverses the payments it recorded.',
                                  'Reverses the CAM / tax / expense additions it made.',
                                  'Any payee rules it learned are un-learned.',
                                  'Estimates it set are restored to their prior values.',
                                ],
                                confirmLabel: 'Undo import',
                                tone: 'warn',
                              })) undoImport.mutate(imp);
                            }}>
                            ↩ Undo
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}

        <LearnedPayeesPanel propId={propId} year={year} />
      </StatementDropZone>

      {editingRow && (
        <MonthDetailPanel
          propertyId={propId}
          year={year}
          month={editing.month}
          row={editingRow.r}
          comp={editingRow.comp}
          alloc={editingRow.alloc}
          onMonth={(m) => setEditing((e) => ({ ...e, month: m }))}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}
