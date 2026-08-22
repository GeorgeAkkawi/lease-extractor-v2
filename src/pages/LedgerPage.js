import { useMemo, useRef, useState } from 'react';
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
  listAlertStates,
  settleTenantBalance,
  undoSettlement,
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
import { allocatePayments, componentizeSchedule, escalationFollowThrough, escalationStepMonths, ledgerRowSummary, monthClosedForLogging, monthExcess, overpayAllKey, overpayKey, recurringSurplus, representativeMonth, snapshotCollectionSummary } from '../lib/ledger';
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
import { tenantStanding, settleChoicesFor, isBroughtForward, isSettlementRow } from '../lib/settle';
import { settleBillingChange, settlePaymentChange } from '../lib/invalidate';
import { paintPayment } from '../lib/rollPaint';
import Panel from '../components/Panel';
import Tip, { TipTitle, TipRow, TipRule, TipNote, TipAction } from '../components/Tip';
import { adjustmentsForMonth, adjustmentKindInfo, pnlDestinationLine } from '../lib/adjustments';
import { incomeCategoriesInUse, incomeCategoryLabel, customCategoryKey } from '../lib/otherIncome';
import { EXPENSE_CATEGORIES } from '../lib/expenseCategories';
import SelectMenu from '../components/SelectMenu';

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

// A raise landed — did the money follow? Everything here is derived by
// escalationFollowThrough from the SAME allocation the boxes paint from:
//   1. WHAT THE BILL'S JUMP WAS MADE OF — George's "recognize what the payment increase
//      should have been on the base and see if the estimate cam and tax increased by
//      that much". The parts always sum to the jump (componentizeSchedule's invariant),
//      so this can't print a decomposition that doesn't add up.
//   2. THE VERDICT — bill vs money in, over the settled months since the step.
// `older_gap` exists because bill-vs-money-in alone misreads a tenant who was ALREADY
// underpaying: the gap looks exactly like a raise they ignored. Naming the older part
// is the difference between a true sentence and a wrong accusation.
//
// ⚠ IT USED TO BE THREE PRINTED LINES under the tenant's name, and George read them back
// as noise: *"the little notes … and the rent raise effect isnt clear"* (2026-08-17). The
// arithmetic is unchanged; what moved is where it is printed. The chip carries the
// verdict at a glance and the card carries the whole story on hover — INCLUDING the raise
// as a before-and-after, which is the part three sentences never actually said.
function raiseVerdict(follow) {
  if (!follow || follow.verdict === 'pending') return { tone: 'muted', label: 'nothing in yet' };
  if (follow.verdict === 'honored') return { tone: 'ok', label: 'picked up' };
  if (follow.verdict === 'over') return { tone: 'ok', label: 'paying over' };
  const per = money(Math.abs(follow.shortPerMonth));
  if (follow.verdict === 'pre_raise_rate') return { tone: 'bad', label: 'still at the old rate' };
  return { tone: 'bad', label: `short ${per}/mo` };
}

function RaiseChip({ step, follow, owed, prevOwed }) {
  if (!step) return null;
  const monthName = MONTHS[step.month - 1];
  const jump = follow ? round2(follow.billJump) : round2(owed - prevOwed);
  const v = raiseVerdict(follow);
  const parts = [];
  if (follow?.stepMonthly > 0.005) parts.push(`${money(follow.stepMonthly)} base rent`);
  if (Math.abs(follow?.camTaxMonthly || 0) > 0.005) parts.push(`${follow.camTaxMonthly < 0 ? '−' : ''}${money(Math.abs(follow.camTaxMonthly))} CAM & tax estimate`);
  if (Math.abs(follow?.roofMonthly || 0) > 0.005) parts.push(`${follow.roofMonthly < 0 ? '−' : ''}${money(Math.abs(follow.roofMonthly))} roof`);

  const n = follow?.settledSince || 0;
  let since = null;
  if (follow) {
    const per = money(Math.abs(follow.shortPerMonth));
    const total = money(Math.abs(follow.shortSince));
    if (follow.verdict === 'pending') since = `Nothing has been recorded since the raise yet.`;
    else if (follow.verdict === 'honored') since = `${n} month${n === 1 ? '' : 's'} settled since ${monthName}, every one at the new bill.`;
    else if (follow.verdict === 'over') since = `Paying ${per}/mo over the new bill — the extra shows in the Collected column.`;
    else if (follow.verdict === 'pre_raise_rate') since = `Short ${per}/mo since ${monthName}${n > 1 ? ` — ${total} over ${n} months` : ''}. The gap IS the raise: this tenant is still paying the pre-raise amount.`;
    else if (follow.verdict === 'older_gap') since = `Short ${per}/mo since ${monthName}, but ${money(Math.abs(follow.shortBeforePerMonth))}/mo of that was already short BEFORE the raise — so the gap is not the escalation alone.`;
    else since = `Picked up ${money(round2(jump - follow.shortPerMonth))} of the ${money(jump)} increase — still short ${per}/mo since ${monthName}${n > 1 ? ` (${total} over ${n} months)` : ''}.`;
  }

  const card = (
    <>
      <TipTitle>Rent raise · {monthName}</TipTitle>
      <TipRow label="Base rent" value={`${money(step.prevBase)} → ${money(step.base)}`} />
      <TipRow label="" value={`+${money(round2(step.base - step.prevBase))}/mo`} sub tone="ok" />
      {jump > 0.005 && prevOwed > 0 && (
        <TipRow label="The whole bill" value={`${money(prevOwed)} → ${money(owed)}`} strong />
      )}
      {parts.length > 0 && (
        <TipRow label="What rose" value={parts.join(' + ')} sub />
      )}
      {parts.length === 1 && <TipNote>Nothing else moved — the CAM &amp; tax estimate is unchanged.</TipNote>}
      {since && (
        <>
          <TipRule />
          <TipNote>{since}</TipNote>
        </>
      )}
    </>
  );

  return (
    <Tip as="span" className={`rr-raise rr-raise-${v.tone}`} tabIndex={0} content={card}>
      ↗ {monthName} raise · {v.label}
    </Tip>
  );
}

// One month of one tenant, as a card: what the bill is made of, every charge or credit
// posted on it (with the note that was typed with it — which until now could be read
// NOWHERE but inside the pop-up), what came in, and what a click will do.
function MonthTip({ ml, tenant, comp, adjRows, owed, received, isStep, settled, lump, outside, abated, action, answered = 0 }) {
  const c = comp || { base: 0, camTax: 0, roof: 0 };
  const diff = round2(received - owed);
  return (
    <>
      <TipTitle>{ml} · {tenant}</TipTitle>
      {outside ? (
        <TipNote>Before this lease began — nothing is billed for {ml}.</TipNote>
      ) : (
        <>
          {owed > 0 || adjRows.length > 0 ? (
            <>
              <TipRow label="Base rent" value={money(c.base)} />
              <TipRow label="CAM &amp; tax" value={money(c.camTax)} />
              {c.roof > 0.005 && <TipRow label="Roof" value={money(c.roof)} />}
              {adjRows.map((a) => (
                <TipRow
                  key={a.id}
                  label={<>{adjustmentKindInfo(a.kind).label}{a.memo ? <em className="tip-memo"> “{a.memo}”</em> : null}</>}
                  value={`${Number(a.amount) < 0 ? '−' : '+'}${money(Math.abs(Number(a.amount) || 0))}`}
                  tone={Number(a.amount) < 0 ? 'ok' : 'warn'}
                />
              ))}
              <TipRow label="Billed" value={money(owed)} strong />
            </>
          ) : abated ? (
            <TipNote>Base rent abated — nothing is due for {ml}.</TipNote>
          ) : null}
          {/* ⚠ A SURPLUS THE LANDLORD HAS ALREADY ANSWERED FOR IS NOT A WARNING (2026-08-21).
              `answered` is the dollars of a surplus released into the live income figures by an
              `alert_states` key — the standing "anything extra from this tenant" answer or this
              month's own. Until now the card warned about it anyway, in the same gold as a
              shortfall, on money George had personally said was revenue. The figure still shows;
              only the alarm goes. A SHORTFALL is never `answered` (there is no answer that makes
              one fine), so it keeps its warn tone unconditionally. */}
          <TipRow
            label="Received"
            value={money(received)}
            strong
            tone={settled && Math.abs(diff) > 0.5 && !answered ? 'warn' : undefined}
          />
          {settled && Math.abs(diff) > 0.5 && (
            <TipRow
              label=""
              value={answered
                ? `${money(answered)} over the bill — counted as revenue`
                : `${money(Math.abs(diff))} ${diff < 0 ? 'under' : 'over'} the bill`}
              sub
              tone={answered ? 'ok' : 'warn'}
            />
          )}
          {answered > 0 && (
            <TipNote>It is in your live income and expenses. Double-click the month to change your mind.</TipNote>
          )}
          {lump && <TipNote>Covered by an untagged lump payment, which fills the months still owing from January onward.</TipNote>}
        </>
      )}
      {isStep && <TipNote>↗ A scheduled rent escalation lands on this month — the higher amount from here is the raise, not an error.</TipNote>}
      {action && <TipAction>{action}</TipAction>}
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

  // ⚠ A REFUSAL PRINTED IN GREEN READS AS A SUCCESS. Every message on this page went through
  // one `badge good`, so "FY 2026 is closed, so nothing was undone" arrived in the same colour
  // as "Recorded". The second argument is what a message says about itself; nothing else about
  // the call sites moves.
  const [note, setNoteRaw] = useState('');
  const [noteBad, setNoteBad] = useState(false);
  const setNote = (text, bad = false) => { setNoteRaw(text); setNoteBad(!!bad); };
  // Statement import: null | { fileName, accountHint, parsed, pdfLane } while reviewing.
  const [importDoc, setImportDoc] = useState(null);
  // The post-save results strip: { summary, import, fileName }.
  const [imported, setImported] = useState(null);
  const [showRegister, setShowRegister] = useState(false);
  // Naming a new other-income category on an unplaced line — the id of the line being
  // named, and the text so far.
  const [namingIncome, setNamingIncome] = useState(null);
  // Rent picked but not yet recorded: { [lineId]: { leaseId, month } }. Two steps on purpose —
  // the tenant and the month are separate decisions, and putting twelve months × N tenants in
  // one dropdown would be unreadable. Cleared when the line is placed or cancelled.
  const [rentPick, setRentPick] = useState({});
  // Expense picked but not yet recorded: { [lineId]: { category, label, billable } }. The
  // second step exists because the answer to "does this reach a tenant's CAM?" cannot be
  // inferred from the category — the same repair bill is recoverable on one building and
  // absorbed on another — and it was FORCED to "no" until 2026-08-16, which is how a genuinely
  // recoverable cost placed after the fact was silently eaten by the landlord.
  const [expensePick, setExpensePick] = useState({});
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
  // Both panels move together — a line leaves one exactly when it joins the other, so a line
  // the landlord has just filed must stop being reported as unplaced in the same breath.
  const settleLines = () => {
    qc.invalidateQueries({ queryKey: ['unplacedLines', propId, year] });
    qc.invalidateQueries({ queryKey: ['decidedLines', propId, year] });
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
  // from. ⚠ Every destination EXCEPT rent writes either an `other_income` row or a NOT-BILLED
  // expense line, and syncCamTotal excludes the latter from cam_total — so those can never
  // move a tenant's bill or this property's NOI. Rent is the exception and has to be: it
  // records a PAYMENT, which changes who has settled without touching what was billed.
  const place = useMutation({
    // The pick encodes its own sub-destination: `rent:<leaseId>`, `income:<category>`,
    // `deposit:<leaseId>` and `expense:<category>` (a distribution is `expense:distribution`).
    mutationFn: ({ line, kind, month = null, billable = false }) => placeUnplacedLine(line, {
      billable,
      kind: kind.startsWith('income:') ? 'income' : kind.startsWith('deposit:') ? 'deposit' : kind.startsWith('expense:') ? 'expense' : kind.startsWith('rent:') ? 'payment' : kind,
      category: kind.startsWith('income:') ? kind.slice(7) : kind.startsWith('expense:') ? kind.slice(8) : null,
      leaseId: kind.startsWith('deposit:') ? kind.slice(8) : kind.startsWith('rent:') ? kind.slice(5) : null,
      month,
      // ⚠ The fiscal year the landlord is looking at, as the LAST fallback behind the
      // line's own year and its transaction date. An expense row written with no year is
      // invisible in every year's figures (`listExpenseLineItems` reads the year exactly),
      // which is how a placed line could read "recorded" and reach no sheet at all.
      year,
    }),
    onSuccess: (res, vars) => {
      settleLines();
      setRentPick((p) => { const n = { ...p }; delete n[vars?.line?.id]; return n; });
      setExpensePick((p) => { const n = { ...p }; delete n[vars?.line?.id]; return n; });
      // A not-billed expense line landed: the CAM list, the bucket records that carry
      // its category, the corp-card distribution roll-up and the Financials strips all
      // read it. `camLineItems` is a prefix so every year of this property repaints.
      qc.invalidateQueries({ queryKey: ['camLineItems'] });
      qc.invalidateQueries({ queryKey: ['expenseBuckets'] });
      qc.invalidateQueries({ queryKey: ['corpDistributions'] });
      qc.invalidateQueries({ queryKey: ['otherIncome'] });
      qc.invalidateQueries({ queryKey: ['depositLines'] });
      // ⚠ A PAYMENT MOVES THE GRID ITSELF, which no other destination does — and everything
      // a payment moves goes through the NAMED set (§6), never a list here. The hand-rolled
      // list this replaces predated `settlePaymentChange` growing `['portfolioBasis']` and
      // `['monthlyRent']`, so filing a bank line as rent repainted the grid and left the
      // Overview band quoting yesterday's live figure — the drift-by-omission the named
      // sets exist to prevent, on the page that states that rule twice.
      settle();
      qc.invalidateQueries({ queryKey: ['invoicesForProperty'] });
      // ⚠ A BILLABLE expense is the one destination that moves a tenant's bill, so it needs the
      // named set for "a billed figure moved" rather than the list above. `placeUnplacedLine`
      // already ran `resyncPropertyBilling`; this is the repaint that follows it (CLAUDE.md §6).
      if (res?.billable) {
        settleBillingChange(qc, { propertyId: propId, year });
        setNote(`Recorded, and billed to tenants — every ${year} invoice on this property was rebuilt at the new CAM total.`);
      }
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
      if (res?.refused) { setNote(res.message, true); return; }
      settleBillingChange(qc, { propertyId: propId, leaseId: res.standing?.lease_id, year });
      if (res.carriedTo) settleBillingChange(qc, { propertyId: propId, leaseId: res.standing?.lease_id, year: res.carriedTo });
      qc.invalidateQueries({ queryKey: ['historyEvents'] });
      setNote(res.wrote ? `${res.description}.` : `${res.standing?.label || 'That tenant'} — left open.`);
    },
  });

  // ⚠ WHAT HAPPENS TO THE MONEY, not "are you sure". The one fact a landlord cannot work out
  // for themselves is which of the four moves the YEAR'S INCOME — only the write-off does —
  // so `movesIncome` comes off the registry rather than being re-decided in this dialog.
  // ⚠ WHICH LINES OF THE SHEET MOVE, in the sheet's own words and with the real figures —
  // George, 2026-08-17: *"the settle up button should say — this money is now going to revenue
  // and then when they accept that number should change the respective categories as noted in
  // the .md."* The categories have always moved correctly; nothing said so before he agreed.
  // Built from `pnlDestination`, the same registry the workbook reads, so a dialog can never
  // name a row the sheet does not print.
  function landsOn(choiceKey, standing, owed) {
    const signed = standing.owes ? -Math.abs(owed) : Math.abs(owed);
    if (choiceKey === 'writeoff') {
      return [
        pnlDestinationLine('writeoff', signed, { year }),
        `Total earned ${signed < 0 ? 'falls' : 'rises'} by ${money(Math.abs(owed))} — the sheet already counted this rent as earned, so forgiving it has to take it back out.`,
      ];
    }
    if (choiceKey === 'carry') {
      return [
        pnlDestinationLine('opening', signed, { year }),
        pnlDestinationLine('opening', -signed, { year: year + 1 }),
        `Total earned does not move in either year — it was earned in ${year}, and counting it again in ${year + 1} would count it twice.`,
      ];
    }
    if (choiceKey === 'refund') {
      return [
        pnlDestinationLine('refund', signed, { year }),
        'Total earned does not move: an overpayment was never income, so handing it back is not a cost. It clears the credit and nothing else.',
      ];
    }
    return [`Nothing moves on the sheet. FY ${year} income keeps counting rent that never arrived — it shows as “of which still uncollected at year end” under what the year left.`];
  }

  async function askSettle(standing, choiceKey) {
    const pick = settleChoicesFor(standing).find((c) => c.key === choiceKey && c.ok);
    if (!pick) return;
    const owed = standing.owes || standing.inCredit;
    const ok = await askConfirm({
      title: `${pick.label} — ${standing.label}?`,
      message: `${standing.owes ? `${standing.label} still owes ${money(owed)} for FY ${year}.` : `${standing.label} is ${money(owed)} ahead for FY ${year}.`}`,
      implications: [
        pick.hint,
        'Where this lands on the Income-and-expenses sheet:',
        ...landsOn(pick.key, standing, owed),
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

  // ⚠ THE WAY BACK. A settlement was reversible only by deleting its rows one at a time from
  // the month panel — which for a carry-forward means finding rows in TWO years and knowing
  // that you have to. Miss the second and the tenant is credited in one year and charged in
  // the other, and each screen reads as correct on its own.
  const undoSettle = useMutation({
    mutationFn: (leaseId) => undoSettlement({ leaseId, propertyId: propId, year }),
    onSuccess: (res, leaseId) => {
      if (res?.refused) { setNote(res.message, true); return; }
      for (const yr of res.years || [year]) settleBillingChange(qc, { propertyId: propId, leaseId, year: yr });
      qc.invalidateQueries({ queryKey: ['historyEvents'] });
      setNote(`${res.description}. ${res.removed} entr${res.removed === 1 ? 'y' : 'ies'} removed across FY ${(res.years || []).join(' and FY ')}.`);
    },
  });

  async function askUndoSettlement(r) {
    const ok = await askConfirm({
      title: `Undo the last settlement on ${r.tenant_name}?`,
      message: `Whatever was written off, carried forward or refunded comes back as an open balance.`,
      implications: [
        'Every entry that settlement wrote is removed — including the one in the following year, if it was carried.',
        'If it was written off, this year’s income goes back UP by that amount: the sheet counted it as earned, and you are no longer forgiving it.',
        'The invoices for every year it touched are rebuilt, so Outstanding moves.',
        'A year you have already closed refuses the whole thing rather than undoing half of it.',
      ],
      confirmLabel: 'Undo it',
      tone: 'warn',
    });
    if (ok) undoSettle.mutate(r.lease_id);
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
          // The only expense that still reaches this branch is a distribution — every other
          // category goes through `askPlaceExpense`, which asks whether tenants reimburse it.
          : 'It is recorded as YOUR money, not the building’s: reported on its own line as “Your own money”, counted in no expense subtotal, and never on a tenant’s CAM.';
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

  // ⚠ AN EXPENSE HAS A SECOND QUESTION, and until 2026-08-16 the app answered it for the
  // landlord and never said so. `placeUnplacedLine` forced `billable: false` — a deliberate
  // safety property ("answering the nag can never move a tenant's bill") that quietly meant a
  // recoverable cost placed after the fact reached "what the year cost you" and no tenant's
  // CAM. George: *"does all this stuff tie into income and expenses where it needs to be?"*
  // It is still OFF by default; what changed is that the choice exists and is stated.
  async function askPlaceExpense(l, pick) {
    const ok = await askConfirm({
      title: `Record this as ${String(pick.label || 'an expense').toLowerCase()}?`,
      message: `${lineLabel(l)} — ${pick.billable ? 'billed to tenants as CAM' : 'not billed to tenants'}.`,
      implications: [
        pick.billable
          ? `It joins this property's ${year} CAM total, so every tenant's share is recalculated and their ${year} invoices are rebuilt at the new figure.`
          : 'It shows in what the year cost you and reaches no tenant’s CAM — you absorb it.',
        pick.billable
          ? 'Their bills go UP by their share of it. This is the only thing on this panel that moves what a tenant owes besides recording rent.'
          : 'No tenant’s bill and no CAM total moves.',
        pick.billable
          ? 'A year you have already closed is left alone — a bill already sent never moves under you.'
          : 'You can change your mind later from the expense list on the Financials page.',
        'It moves to “Decided” below, naming where it went.',
      ],
      confirmLabel: pick.billable ? 'Record and bill it' : 'Record it',
      // Gold, not red: money moves onto tenants' bills. Nothing is destroyed.
      tone: pick.billable ? 'warn' : 'default',
    });
    if (ok) place.mutate({ line: l, kind: `expense:${pick.category}`, billable: pick.billable });
  }

  // ⚠ RENT IS THE ONE DESTINATION THAT MOVES THE LEDGER, so its confirm says the opposite of
  // every other one on this panel. The others all promise "no tenant's bill moves"; this one
  // has to say plainly that it settles a month, and equally plainly that it does not change
  // what was BILLED — the distinction the whole app rests on.
  async function askPlaceRent(l, pick) {
    const who = derived.find(({ r }) => r.lease_id === pick.leaseId)?.r;
    const m = pick.month;
    const owedThat = m ? round2(Number(who?.schedule?.[m]?.owed) || 0) : 0;
    const amt = Math.abs(Number(l.amount) || 0);
    const ok = await askConfirm({
      title: `Record this as ${who?.tenant_name || 'this tenant'}’s rent?`,
      message: `${lineLabel(l)} — for ${m ? `${MONTHS[m - 1]} ${year}` : 'no particular month'}.`,
      implications: [
        m
          ? `${MONTHS[m - 1]} is marked paid at ${money(amt)}${owedThat ? ` against the ${money(owedThat)} billed` : ''}. A month settles at whatever arrived — this does not change what was billed.`
          : 'Left untagged, so the ledger spreads it across the months still owed, earliest first.',
        'It is recorded as money RECEIVED. Income and expenses counts rent when it falls DUE, so the projected copy of that sheet does not move — the Ledger and the live copy do.',
        'It carries the statement it came from, so re-importing that statement later cannot book it twice.',
      ],
      confirmLabel: 'Record it',
      tone: 'default',
    });
    if (ok) place.mutate({ line: l, kind: `rent:${pick.leaseId}`, month: m });
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
  // invoices/payments panels; deliberately not a blanket sweep. Named rather than hand-rolled
  // since 2026-08-17, because the month pop-up needed the identical set and a second copy of a
  // list like this is how the two drift apart by omission (CLAUDE.md §6).
  const settle = () => settlePaymentChange(qc, { propertyId: propId });

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

  // Optimistic paint: adjust the row's raw payments (what the allocation derives from) so the
  // click repaints instantly while the write settles. Shared with the month pop-up's own
  // painter (lib/rollPaint.js) — one cache, one idea of what it looks like afterwards.
  const paint = (old, leaseId, month, action, amount) =>
    paintPayment(old, leaseId, month, action, amount, { today: localDateIso() });

  const cellMut = useMutation({
    // Every write carries a real amount (open→full owed, gap→the residual) so markMonthPaid
    // skips the schedule rebuild AND the optimistic paint moves a real figure, not undefined.
    mutationFn: ({ leaseId, month, action, amount }) =>
      action === 'unmark'
        ? unmarkMonthPaid(leaseId, year, month)
        : markMonthPaid(leaseId, propId, year, month, { amount }),
    onMutate: async ({ leaseId, month, action, amount, prePainted = false, prev: painted }) => {
      setPendingCells((s) => new Set(s).add(cellKey(leaseId, month)));
      await qc.cancelQueries({ queryKey: rollKey });
      // ⚠ The tap handler below paints BEFORE it schedules the write, so the box answers
      // the click at once and a double-click still has time to take it back. Painting a
      // second time here would record the month twice over.
      if (prePainted) return { prev: painted };
      const prev = qc.getQueryData(rollKey);
      qc.setQueryData(rollKey, (old) => paint(old, leaseId, month, action, amount));
      return { prev };
    },
    onError: (_e, _v, ctx) => { if (ctx?.prev) qc.setQueryData(rollKey, ctx.prev); setNote('Could not save that change — please try again.', true); },
    onSettled: (_d, _e, vars) => {
      setPendingCells((s) => { const n = new Set(s); n.delete(cellKey(vars.leaseId, vars.month)); return n; });
      settle();
    },
  });

  // ── One click on, one click off, double-click to open ────────────────────────────────
  //
  // George, 2026-08-17: *"theres no way to uncheck a box on the ledger. it should be one
  // click to mark it paid one to mark it unpaid and a double click to enter the pop up not
  // an undo this month in the popup to remove it."*
  //
  // ⚠ THE ORDER OF EVENTS IS THE WHOLE PROBLEM. A browser fires click, click, dblclick —
  // so acting on the first click means a double-click has already written something before
  // the second click arrives. Two things follow, and both are deliberate:
  //   1. The cache is painted IMMEDIATELY (the box answers with no delay at all) but the
  //      network write is held for TAP_MS. A double-click inside that window clears the
  //      timer and puts the cache back, so nothing was ever sent.
  //   2. Opening the pop-up waits the same window even on a plain single click — because
  //      the modal's scrim is full-screen, and a pop-up opened on the FIRST click would
  //      catch the second click on its scrim and close itself again.
  // Past the window the write has gone; the pop-up then opens on the month as it now
  // stands, which is coherent rather than surprising.
  const TAP_MS = 260;
  const tapRef = useRef(null);

  // Take a pending tap BACK without firing it — the double-click path. Only ever right for
  // the cell the double-click landed on: taking back another cell's tap is losing a click.
  const cancelTap = () => {
    const t = tapRef.current;
    if (!t) return;
    tapRef.current = null;
    clearTimeout(t.id);
    if (t.paint) {
      if (t.prev !== undefined) qc.setQueryData(rollKey, t.prev);
      setPendingCells((s) => { const n = new Set(s); n.delete(t.key); return n; });
    }
  };

  // Commit a pending tap NOW. `tapRef` holds one tap, so touching a second cell inside the
  // first cell's window has to resolve the first — and the resolution is to fire it, not to
  // take it back: its window existed only to catch a double-click on ITS OWN cell.
  const flushTap = () => {
    const t = tapRef.current;
    if (!t) return;
    tapRef.current = null;
    clearTimeout(t.id);
    t.fire();
  };

  // ⚠ THE RULE THAT KEEPS FAST MARKING HONEST. Every tap entry point resolves any pending
  // tap through this: our own cell's pending tap is a double-click being taken back
  // (cancel); a DIFFERENT cell's is a decision already made (flush). It used to be
  // `cancelTap()` unconditionally — so ticking two months within the 260ms window silently
  // reverted the first ✓ and never sent its write, on the grid whose own comment promises
  // "parallel marks work". No error, no record, just a click that didn't count.
  const yieldTap = (key) => {
    const t = tapRef.current;
    if (!t) return;
    if (t.key === key) cancelTap(); else flushTap();
  };

  // A single click that does something after the double-click window has passed. `key` names
  // the cell so a click elsewhere flushes this rather than cancelling it.
  const tap = (fn, key) => {
    yieldTap(key);
    const id = setTimeout(() => { tapRef.current = null; fn(); }, TAP_MS);
    tapRef.current = { id, key, paint: false, fire: fn };
  };

  const tapToggle = ({ leaseId, month, action, amount }) => {
    const key = cellKey(leaseId, month);
    yieldTap(key);
    const prev = qc.getQueryData(rollKey);
    qc.setQueryData(rollKey, (old) => paint(old, leaseId, month, action, amount));
    setPendingCells((s) => new Set(s).add(key));
    const fire = () => cellMut.mutate({ leaseId, month, action, amount, prePainted: true, prev });
    const id = setTimeout(() => { tapRef.current = null; fire(); }, TAP_MS);
    tapRef.current = { id, key, prev, paint: true, fire };
  };

  const openMonth = (leaseId, month) => { yieldTap(cellKey(leaseId, month)); setEditing({ leaseId, month }); };

  // ⚠ ONE CLICK MUST NOT SILENTLY DELETE A BANK PAYMENT. `unmarkMonthPaid` removes every
  // payment tagged to the month — and where one came from an imported statement, that is a
  // deposit the bank really showed being erased on a stray click, with the statement line it
  // came from left pointing at nothing. So the one-click undo is for what the app recorded;
  // anything else asks first and names what it holds.
  const unmarkNeedsAsk = (tagged) => tagged.length > 1 || tagged.some((p) => p.source === 'import');

  async function askUnmark(r, m, tagged) {
    const imported = tagged.filter((p) => p.source === 'import');
    const ok = await askConfirm({
      title: `Take ${MONTHS[m - 1]} back for ${r.tenant_name}?`,
      message: `${tagged.length} payment${tagged.length === 1 ? '' : 's'} recorded against ${MONTHS[m - 1]} ${year}, totalling ${money(tagged.reduce((s, p) => s + (Number(p.amount) || 0), 0))}.`,
      implications: [
        // ⚠ IT SAYS WHERE THE MONEY GOES, because since 2026-08-17 it goes somewhere. The
        // deposit is un-decided rather than orphaned (`releaseStatementLine`), so it lands
        // back on the panel below with its own date and description and can be re-filed
        // against the right month — which is what "recording it again dates it today"
        // exists to warn you off doing.
        imported.length > 0
          ? `${imported.length === tagged.length ? 'This money' : `${imported.length} of these`} came from an imported bank statement. The deposit goes back to “Money not yet placed” below, keeping its real date and description — file it from there rather than re-ticking the box, and it keeps its link to the statement.`
          : 'Every one of them is deleted — the month goes back to owing its full bill.',
        'Any charges or credits on this month stay. They are what was billed, not what was paid.',
        'Recording it again by ticking the box dates the payment today, not when the money actually arrived.',
      ],
      confirmLabel: `Take ${MONTHS[m - 1]} back`,
      tone: 'warn',
    });
    if (ok) cellMut.mutate({ leaseId: r.lease_id, month: m, action: 'unmark' });
  }

  // What a click does on a box, resolved once so the handler and the hover card's closing
  // line can never describe different behaviour.
  const cellClick = (fn) => (e) => { if (e.detail > 1) return; fn(); };
  const allMut = useMutation({
    mutationFn: (month) => markMonthPaidAllTenants(propId, year, month),
    onError: () => setNote('Could not mark all paid — please try again.', true),
    onSuccess: (res, month) => {
      setNote(`Marked ${MONTHS[month - 1]} paid for ${res.paid} tenant${res.paid === 1 ? '' : 's'}${res.skipped ? ` (${res.skipped} already covered or free)` : ''}.`);
    },
    onSettled: settle,
  });
  const catchUpAll = useMutation({
    // One round-trip for every due month × every tenant (the plural bulk), not a serial loop.
    mutationFn: (months) => markMonthsPaidAllTenants(propId, year, months),
    onSuccess: (res) => setNote(res.paid ? `Recorded ${res.paid} tenant-month${res.paid === 1 ? '' : 's'} of rent.` : 'Everyone was already caught up.'),
    onError: () => setNote('Could not catch up the ledger — please try again.', true),
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
    onSuccess: (res) => (res?.skipped === 'closed'
      // Not a failure and not a success — the year is closed and the bill was deliberately
      // left alone. Gold says "nothing happened, and here is why" without crying error.
      ? setNote('That year is closed, so its bill was left exactly as it was sent.', true)
      : setNote('Rebuilt this tenant’s bill from the lease as it stands now.')),
    onError: () => setNote('Could not rebuild that bill — please try again.', true),
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

  // Which surpluses the landlord has already answered for. One cached read shared with the
  // month panel (`['alertStates']`), which is also what makes the box repaint the moment the
  // answer is given.
  const { data: alertStateRows } = useQuery({ queryKey: ['alertStates'], queryFn: listAlertStates });
  const confirmedOverpay = useMemo(
    () => new Set((alertStateRows || []).filter((s) => s?.dismissed).map((s) => String(s.alert_key))),
    [alertStateRows],
  );

  // Derive each row's allocation / components / summary ONCE per render, then order
  // the tenants by the shared sort preference (name / size / rent / suite).
  const tenantSort = leaseSort.tenants || {};
  const derived = sortTenantRows(
    rows.map((r) => {
      const alloc = allocatePayments({ owedByMonth: r.schedule, payments: r.payments, adjustments: r.adjustments });
      const comp = componentizeSchedule({ schedule: r.schedule, factor: r.factor, camTaxAnnual: r.camTaxAnnual, roofAnnual: r.roofAnnual, camTaxByMonth: r.camTaxByMonth, roofByMonth: r.roofByMonth, adjustments: r.adjustments });
      const summary = ledgerRowSummary({ year, owedByMonth: r.schedule, allocation: alloc, today });
      const steps = escalationStepMonths({ schedule: r.schedule, comp });
      // Money that arrived beyond what the month billed, and whether the landlord has said
      // what it is. Undecided, it is in NONE of the live income figures (incomeExpense.js) —
      // so the box has to be the thing that says so, or the money is withheld invisibly.
      const excess = monthExcess(alloc);
      // A surplus on three months or more is a RENT question, not an accounting one.
      const surplusRun = recurringSurplus(excess);
      // Did the money follow the raise? Same allocation the boxes paint from, so the
      // verdict and the row's own `short $X` chip can never disagree.
      const followUp = escalationFollowThrough({ year, owedByMonth: r.schedule, allocation: alloc, steps, comp, today });
      // ⚠ The alloc and summary already derived above are HANDED IN, not re-derived. The
      // workbook's copy of this block builds its own from the same two choke points; what
      // must never happen is a third arithmetic for "what does this tenant owe" (CLAUDE.md §3),
      // because the number on this row is the number the Settle up button acts on.
      const standing = tenantStanding({ row: r, year, today, alloc, summary });
      // ⚠ THE LOGICAL PATH BETWEEN THE TWO YEARS, and there was none (George: *"if an over or
      // undercharge is rolled through to a following year or month how does that show is there
      // a logical path for that stuff?"*). A carry writes two rows in two years; next January's
      // was anonymous, so the money simply appeared. `isBroughtForward` reads the memo the
      // settlement wrote — the only thing separating an `opening` row that ARRIVED from one
      // that CLEARED, since the kind is identical and the sign flips with the direction.
      const adjRows = r.adjustmentRows || [];
      const carriedIn = adjRows.filter(isBroughtForward)
        .reduce((s, a) => round2(s + (Number(a.amount) || 0)), 0);
      // Any settlement row at all — what makes an undo worth offering on this row.
      const settlementRows = adjRows.filter(isSettlementRow);
      return { r, alloc, comp, summary, steps, followUp, standing, carriedIn, settlementRows, excess, surplusRun };
    }),
    { mode: tenantSort.mode, dir: tenantSort.dir, pick: (d) => d.r }
  );

  // The row the month panel is open on — resolved from the SAME derived array the grid
  // paints from, so the panel and the box it was opened from can never disagree (and it
  // repaints automatically after a post).
  const editingRow = editing ? derived.find(({ r }) => r.lease_id === editing.leaseId) : null;

  // ⚠ THE APP'S OWN CONFIRM, not window.confirm — these were the page's last two bare
  // browser dialogs (2026-08-18 (15)). The difference is not styling: a bulk mark is the
  // biggest single write this grid can make, and the native box could not say what it was
  // about to do, what it prices the months at, or how to take one back.
  const markAll = async (m) => {
    const unpaid = derived.filter(({ alloc }) => round2(alloc.owed[m - 1] - alloc.coverage[m - 1]) > 0.05).length;
    if (unpaid === 0) { setNote(`Everyone is already covered for ${MONTHS[m - 1]}.`); return; }
    const ok = await askConfirm({
      title: `Mark ${MONTHS[m - 1]} paid for ${unpaid} tenant${unpaid === 1 ? '' : 's'}?`,
      message: `Every tenant still owing on ${MONTHS[m - 1]} ${year} is recorded as paid.`,
      implications: [
        'Each month is recorded at what that tenant still owes — priced off their own lease, so a partly-covered month is topped up by its gap only.',
        'Tenants already covered, out of term or rent-free are skipped.',
        'These are app-priced marks: if a billed figure later changes, they follow it. Money off a bank statement is recorded by importing the statement instead.',
        'One click on any box takes that month back.',
      ],
      confirmLabel: `Mark ${MONTHS[m - 1]} paid`,
      tone: 'default',
    });
    if (ok) allMut.mutate(m);
  };
  const catchUp = async () => {
    if (!throughM) return;
    const months = Array.from({ length: throughM }, (_, i) => i + 1);
    const ok = await askConfirm({
      title: `Mark everyone paid through ${MONTHS[throughM - 1]}?`,
      message: `Every unpaid month that has come due — January through ${MONTHS[throughM - 1]} ${year} — is recorded as paid, for every tenant.`,
      implications: [
        'Each month is recorded at what that tenant still owes on it — never more than its own bill.',
        'Months already covered, out of term or rent-free are skipped.',
        'These are app-priced marks: if a billed figure later changes, they follow it. Money off a bank statement is recorded by importing the statement instead.',
        'One click on any box takes a month back.',
      ],
      confirmLabel: `Mark paid through ${MONTHS[throughM - 1]}`,
      tone: 'default',
    });
    if (ok) catchUpAll.mutate(months);
  };
  const behindTotal = derived.reduce((acc, { summary }) => acc + summary.monthsBehind, 0);
  const totalCollected = derived.reduce((s, { summary }) => s + summary.collected, 0);
  const totalProjected = derived.reduce((s, { summary }) => s + summary.projected, 0);
  const totalBilled = derived.reduce((s, { summary }) => s + summary.billed, 0);
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
        {/* ⚠ THE KEY ROW IS GONE, and its removal is the point rather than a tidy-up (George,
            2026-08-17: *"the boxes of partly covered, not the billed amount, covered by a lump,
            and received not billed are not needed. we can take those out"* — then, asked how
            far, *the whole Key row*). Eight swatches existed because a box could not explain
            itself; hovering one now prints what it is made of, so the legend was the OLD way
            of saying it, sitting above the new way. Two explanations of one thing drift, and
            the printed one drifts silently because nothing compares them.
            What stays is the part a hover cannot tell you: that a box is CLICKABLE at all. */}
        <div className="rr-howto">
          <span>
            Hover any box for what it is made of. One click records a month, one click takes it
            back; double-click to open it. A payment with no month recorded fills the earliest
            months first.
          </span>
          {prevCollection?.rate != null && (
            <Link to={`/history/${corpId}/${propId}`} className="rr-tenant" title="From the closed year's snapshot — open History for the trend">FY {year - 1} collection rate: {Math.round(prevCollection.rate * 100)}%</Link>
          )}
        </div>
        {note && <p className={`note-msg ${noteBad ? 'warn' : 'good'}`} style={{ marginBottom: 10 }}>{note}</p>}
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
              {derived.map(({ r, alloc, comp, summary, steps, followUp, standing, carriedIn, settlementRows, excess, surplusRun }) => {
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
                      {/* …and whether the money followed. Judged from the SAME step the
                          chip names — on the rare twice-stepped lease the two must talk
                          about one month, or the row contradicts itself.
                          escalationFollowThrough returns every step, so a later round can
                          refine which one without touching this. */}
                      {steps.length > 0 && (
                        <div>
                          <RaiseChip
                            step={steps[0]}
                            follow={followUp?.[0]}
                            owed={round2(alloc.owed[steps[0].month - 1])}
                            prevOwed={round2(alloc.owed[steps[0].month - 2])}
                          />
                        </div>
                      )}
                    </td>
                    {MONTHS.map((ml, i) => {
                      const m = i + 1;
                      const s = r.schedule?.[m];
                      const c = comp[m];
                      const adjM = round2(Number(c?.adj) || 0);
                      // ⚠ A CHARGE OR CREDIT NO LONGER PRINTS A THIRD LINE INSIDE THE BOX.
                      // `.rr-adj` was `display:block` under the figure, so posting one made
                      // the box taller AND wider and the whole twelve-column grid reflowed
                      // — George: *"if i add a charge or credit the box gets way bigger and
                      // doesnt look good"*. It is a corner mark now (gold = a charge, forest
                      // = a credit), the box never changes size, and the amount, the kind
                      // and the note typed with it are all on the hover card.
                      const adjRows = Math.abs(adjM) > 0.005 || (r.adjustmentRows || []).length
                        ? adjustmentsForMonth(r.adjustmentRows || [], m)
                        : [];
                      const adjCls = Math.abs(adjM) > 0.005 ? ` has-adj${adjM < 0 ? ' adj-credit' : ''}` : '';
                      const adjMark = Math.abs(adjM) > 0.005 ? <span className="rr-mark" /> : null;
                      const open = () => openMonth(r.lease_id, m);
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
                      // Money recorded FOR a month the lease bills nothing for (a tenant
                      // whose lease starts later in the year, an abated month). The tag
                      // holds — it renders before the out-of-term / abated cells, which
                      // would otherwise print "—" over a real deposit and leave the money
                      // to drift onto whatever month the lease does bill.
                      const tagged = (r.payments || []).filter((p) => Number(p.period_month) === m);
                      // The card and the handler read the same two lines, so the box can
                      // never promise one thing and do another.
                      const card = (props) => (
                        <MonthTip
                          ml={ml} tenant={r.tenant_name} comp={c} adjRows={adjRows}
                          owed={round2(owedM)} received={round2(receivedM)} isStep={isStep}
                          {...props}
                        />
                      );
                      const takeBack = () => {
                        if (pending) return;
                        if (unmarkNeedsAsk(tagged)) tap(() => askUnmark(r, m, tagged), cellKey(r.lease_id, m));
                        else tapToggle({ leaseId: r.lease_id, month: m, action: 'unmark' });
                      };
                      // ⚠ A SINGLE-CLICK OPEN WAITS THE SAME WINDOW AS EVERYTHING ELSE. The
                      // pop-up's scrim is full-screen, so a panel opened on the FIRST click
                      // catches the second click of a double-click on itself and closes —
                      // the design note above always said this wait existed, and until
                      // 2026-08-18 the four open-on-click cells didn't have it: double-
                      // clicking a lump-covered month flashed the panel open and shut.
                      const openTap = () => tap(open, cellKey(r.lease_id, m));

                      if (state === 'unbilled') {
                        return (
                          <td key={m}>
                            <Tip as="button" type="button" className={`rr-cell recv${adjCls}${pending ? ' is-pending' : ''}`} aria-disabled={pending}
                              onClick={cellClick(takeBack)} onDoubleClick={open}
                              content={card({ settled: true, action: 'Click to take this month back · double-click to open it' })}
                              aria-label={`${ml} — ${money(receivedM)} received, nothing billed`}>
                              {adjMark}↓<span className="rr-amt">{money0(receivedM)}</span>
                            </Tip>
                          </td>
                        );
                      }
                      if (s?.outsideTerm && !(owedM > 0)) {
                        return (
                          <td key={m}>
                            <Tip as="button" type="button" className="rr-cell outside"
                              onClick={cellClick(openTap)} onDoubleClick={open}
                              content={card({ outside: true, action: 'Click to open this month' })}
                              aria-label={`${ml} — before this lease began`}>—</Tip>
                          </td>
                        );
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
                        // ⚠ NAME THE DECISION, not just its effect. "This month was settled"
                        // still leaves the landlord clicking through to find out WHICH — and
                        // the memo the settlement wrote says it in four words. Falls back to
                        // the generic sentence for a plain credit somebody posted by hand.
                        const why = settlementRows
                          .filter((a) => Number(a.month) === m && Number(a.amount) < 0)
                          .map((a) => a.memo).filter(Boolean)[0] || null;
                        return (
                          <td key={m}>
                            <Tip as="button" type="button" className={`rr-cell ${forgiven ? 'settled-off' : 'abated'}`}
                              onClick={cellClick(openTap)} onDoubleClick={open}
                              aria-label={`${ml} — ${forgiven ? 'settled, not billed' : 'base rent abated'}`}
                              content={(
                                <>
                                  <TipTitle>{ml} · {r.tenant_name}</TipTitle>
                                  {forgiven ? (
                                    <>
                                      <TipRow label="Credited" value={money(Math.abs(adjM))} tone="ok" strong />
                                      <TipNote>{why ? `${why}. ` : ''}This month was settled, not billed — a decision somebody made, not a rent-free period the lease grants.</TipNote>
                                    </>
                                  ) : (
                                    <TipNote>Base rent abated — the lease grants this month rent-free, so nothing is due.</TipNote>
                                  )}
                                  <TipAction>Click to open this month and see the entry that did it</TipAction>
                                </>
                              )}>
                              {forgiven ? '⌫' : 'F'}
                            </Tip>
                          </td>
                        );
                      }
                      const started = year < curY || (isCurrentFy && m <= curM);
                      if (state === 'covered') {
                        // A TAGGED month is settled — "paid = paid": it reads ✓ whatever the
                        // amount, and stays clickable.
                        if (settledM) {
                          const diff = round2(receivedM - owedM);
                          // ⚠ THE BOX CARRIES THE DIFFERENCE NOW, not only its figure. The
                          // earlier rule (only the FIGURE tints) is George's own, and he
                          // overrode it on 2026-08-17: *"if a charge comes in above or below
                          // … we just have the box itself change to a different color and
                          // when you hover over it it explains what has happened."* The ✓
                          // stays, so "paid = paid" still reads; gold is the same
                          // "look at this" gold the other states already use.
                          // ⚠ A SURPLUS NOBODY HAS ANSWERED FOR IS BEING WITHHELD FROM THE LIVE
                          // INCOME FIGURES (2026-08-17), so the box must say so or the money is
                          // held back invisibly — the one failure this whole change could cause.
                          const surplus = round2(excess?.[i] || 0);
                          // The standing answer ("anything extra from this tenant is revenue")
                          // settles every month at once — that is what it is for; the per-month
                          // answer settles just this one. Either releases the money.
                          const answered = surplus > 0.05
                            && (confirmedOverpay.has(overpayAllKey(r.lease_id, year))
                             || confirmedOverpay.has(overpayKey(r.lease_id, year, m, surplus)));
                          const awaiting = surplus > 0.05 && !answered;
                          // ⚠ GOLD MEANS "LOOK AT THIS", AND ONCE THE LANDLORD HAS ANSWERED THERE
                          // IS NOTHING LEFT TO LOOK AT (George, 2026-08-21: *"so i clicked always
                          // count as revenue … but the box is still yellow"*). Until now the fill
                          // said only "cash ≠ bill" and the ANSWER cleared a 3px ring on top of it
                          // — so answering changed almost nothing on screen, which reads as the
                          // click not registering. The month is settled at a figure he endorsed
                          // himself and the money is in the live income figures, so it goes back
                          // to a plain green ✓. A SHORTFALL keeps its gold unconditionally:
                          // `surplus` is 0 when `diff < 0`, so `answered` can never be true on a
                          // short month, and no answer makes one fine.
                          const off = Math.abs(diff) > 0.5 && !answered;
                          return (
                            <td key={m}>
                              <Tip as="button" type="button" className={`rr-cell paid${off ? ' off' : ''}${awaiting ? ' awaiting' : ''}${s?.abated ? ' abated' : ''}${stepCls}${adjCls}${pending ? ' is-pending' : ''}`} aria-disabled={pending}
                                onClick={cellClick(takeBack)} onDoubleClick={open}
                                aria-label={`${ml} paid — ${money(receivedM)} received of ${money(owedM)} billed${awaiting ? `, ${money(surplus)} not yet applied` : ''}${answered ? `, ${money(surplus)} extra counted as revenue` : ''}`}
                                content={card({
                                  settled: true,
                                  answered: answered ? surplus : 0,
                                  action: awaiting
                                    ? `${money(surplus)} more than this month billed is in none of your income figures — double-click to say what it is`
                                    : 'Click to take this month back · double-click to open it',
                                })}>
                                {adjMark}✓<span className="rr-amt">{money0(receivedM)}</span>
                              </Tip>
                            </td>
                          );
                        }
                        // Covered by an untagged lump. Nothing month-specific to take back —
                        // the lump spans months — so a click opens it instead of toggling.
                        return (
                          <td key={m}>
                            <Tip as="button" type="button" className={`rr-cell paid pool${stepCls}${adjCls}${pending ? ' is-pending' : ''}`}
                              onClick={cellClick(openTap)} onDoubleClick={open}
                              aria-label={`${ml} — ${money(receivedM)} drawn from a lump payment`}
                              content={card({ lump: true, action: 'Click to open this month' })}>
                              {adjMark}✓<span className="rr-amt">{money0(receivedM)}</span>
                            </Tip>
                          </td>
                        );
                      }
                      if (state === 'partial') {
                        // Part-covered by a lump. Opens the month, where "Record $X received"
                        // closes the gap in one click and an adjustment says the bill was different.
                        const gap = round2(owedM - covered);
                        return (
                          <td key={m}>
                            <Tip as="button" type="button" className={`rr-cell partial${stepCls}${adjCls}${pending ? ' is-pending' : ''}`}
                              onClick={cellClick(openTap)} onDoubleClick={open}
                              aria-label={`${ml} — part covered, ${money(gap)} still owing`}
                              content={card({ lump: true, action: `Click to open this month and record the remaining ${money(gap)}` })}>
                              {adjMark}◐
                            </Tip>
                          </td>
                        );
                      }
                      // An OPEN month: one click records it.
                      // ⚠ OVERDUE needs the month to have ENDED, not merely started (George,
                      // 2026-08-13). The bank statement that would prove August was paid does
                      // not exist until August does, so painting the running month gold
                      // accuses a tenant of something nobody can know yet. Same rule and same
                      // function as `monthsBehind` and the two dashboard reminders. The cell
                      // stays clickable and still says the month is due — only the alarm waits.
                      const late = started && monthClosedForLogging(year, m, today, 0);
                      return (
                        <td key={m}>
                          <Tip as="button" type="button" className={`rr-cell${late ? ' late' : ''}${s?.abated ? ' abated' : ''}${stepCls}${adjCls}${pending ? ' is-pending' : ''}`} aria-disabled={pending}
                            onClick={cellClick(() => { if (pending) return; tapToggle({ leaseId: r.lease_id, month: m, action: 'mark', amount: round2(owedM) }); })}
                            onDoubleClick={open}
                            aria-label={`${ml} — ${late ? 'overdue' : started ? 'due'  : 'not yet due'}, ${money(owedM)} owed`}
                            content={card({ action: `Click to record ${ml} paid · double-click to open it` })}>
                            {adjMark}—
                          </Tip>
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
                        {/* ⚠ THE RENT QUESTION, ON THE ROW WHERE THE RENT IS. George,
                            2026-08-17: *"if the user continues to notice it they can just
                            change the base rent manually."* Right — and the app's job is to
                            be the one that notices. Three months of the same surplus is a
                            recorded rent that has fallen behind what the tenant actually
                            pays, and no number of per-month decisions fixes that. */}
                        {surplusRun.recurring && (
                          <span className="rr-overpaid"
                            title={`Paid over on ${surplusRun.months.length} months this year, about ${money(surplusRun.typical)} each time. If that is the real rent, change it on the lease — open the tenant above.`}>
                            over {surplusRun.months.length} mo · check the rent
                          </span>
                        )}
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
                      {/* ⚠ `settled` WAITS FOR THE MONTH TO END, and that is the fix for George's
                          "why does it say every tenant owes something?". Rent falls due on the 1st,
                          so a balance built from every month that has fallen DUE puts an owing
                          figure — and an offer to write it off — on every tenant on the 1st of
                          every month, for money whose bank statement cannot exist yet. The
                          receivable is still carried (`closing`) for the workbook and the
                          close-year confirm; what waits is the accusation and the action. */}
                      {!standing.settled && (
                        <div className="rr-drift">
                          <span title={
                            `${standing.owes ? 'Unpaid on' : 'Ahead by, across'} the months that have ENDED — the ones whose bank statement should have arrived.`
                            + (standing.provisional > 0.005
                              ? ` A further ${money(standing.provisional)} is owed on the month still running; it is not counted here because nothing has yet told you whether it arrived.`
                              : '')
                          }>
                            {standing.owes ? 'owes' : 'in credit'} <strong>{money(standing.owes || standing.inCredit)}</strong>
                          </span>
                          {/* The same shape as the unplaced panel's "Record as…" — a pick that
                              confirms before it writes. Leaving it open needs no entry: it is
                              what happens when nothing is chosen. */}
                          <SelectMenu
                            className="text-input" style={{ maxWidth: 150, fontSize: 11 }}
                            value="" disabled={settleUp.isPending}
                            onChange={(e) => { if (e.target.value) askSettle(standing, e.target.value); }}
                            title="Close this balance out — leave it open, write it off, carry it into next January, or record a refund."
                          >
                            <option value="">Settle up…</option>
                            {settleChoicesFor(standing).filter((c) => c.ok && c.key !== 'leave').map((c) => (
                              <option key={c.key} value={c.key}>{c.label}</option>
                            ))}
                          </SelectMenu>
                        </div>
                      )}
                      {/* ⚠ THE OTHER END OF A CARRY-FORWARD, NAMED. Without this, January of the
                          receiving year simply carries a large anonymous adjustment and the money
                          appears from nowhere — the halves of one decision, sitting in two years,
                          with nothing joining them. */}
                      {Math.abs(carriedIn) > 0.005 && (
                        <div className="rr-drift">
                          <span title={
                            `${money(Math.abs(carriedIn))} ${carriedIn > 0 ? 'they still owed' : 'they were ahead by'} at the end of FY ${year - 1}, carried into this year rather than written off or refunded.`
                            + ` FY ${year - 1} was cleared by the matching entry, so the money is counted once, in the year it was earned.`
                          }>
                            {money(Math.abs(carriedIn))} {carriedIn > 0 ? 'brought forward' : 'credit brought forward'} from {year - 1}
                          </span>
                        </div>
                      )}
                      {/* ⚠ ONE ACTION, BOTH YEARS. Removing a carry-forward's rows by hand from
                          the month panel takes back one half of it and leaves the other year
                          holding its own — which reads as correct on both screens. This works
                          from the ids the settlement recorded, so it removes exactly what that
                          decision wrote and nothing that merely looks like it. */}
                      {settlementRows.length > 0 && (
                        <div className="rr-drift">
                          <button type="button" className="ghost btn-sm" disabled={undoSettle.isPending}
                            title="Take back the last settlement on this tenant — every entry it wrote, in both years."
                            onClick={() => askUndoSettlement(r)}>
                            Undo settlement
                          </button>
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
              {/* ⚠ This used to end "re-import that statement to place it", which meant still
                  having the PDF — the dead end George hit. Rent is now one of the choices. */}
              {unplacedTotals.unplacedIn > 0 && ' Money in that is rent goes under “Tenant rent”, where you pick the tenant and the month it pays — a cheque that cleared in March can be April’s rent.'}
              {' '}Or leave one out for good, and say why.
            </div>
            {/* ⚠ FIXED COLUMNS, and it is not cosmetic. With auto layout the last cell's
                two 210px selects set the table's width, so putting a line BACK from Decided
                re-measured every column and the Amount figures moved under their own header
                (George, 2026-08-17: *"the fomratting on the money not placed yet is also off
                near the amounts collumn when i added the 5 points entry back"*). Fixed
                widths pin Amount where it is however many lines are on the list. */}
            <table className="line-table">
              <colgroup>
                <col style={{ width: 78 }} /><col /><col style={{ width: 104 }} /><col style={{ width: 232 }} />
              </colgroup>
              <thead><tr><th>Date</th><th>Description</th><th className="num">Amount</th><th></th></tr></thead>
              <tbody>
                {unplaced.map((l) => (
                  <tr key={l.id}>
                    <td>{fmtShortDate(l.txn_date) || '—'}</td>
                    <td className="line-desc" title={l.description || ''}>{l.description || '—'}</td>
                    <td className="num">{l.direction === 'in' ? '+' : '−'}{money(Math.abs(Number(l.amount) || 0))}</td>
                    <td className="line-actions">
                      {/* The nag is answerable, not just silenceable — these are the
                          homes that make the panel a work-list rather than a complaint. */}
                      {namingIncome === l.id ? (
                        /* Naming a category the list doesn't have yet. Inline rather than a
                           modal: the row's date, description and amount are the context for
                           what to call it, and a dialog would cover them. */
                        <div className="line-step">
                          <input className="text-input" autoFocus
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
                      <SelectMenu
                        className="text-input"
                        value=""
                        disabled={place.isPending}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (!v) return;
                          if (v === NEW_INCOME) { setNamingIncome(l.id); setIncomeDraft(''); return; }
                          // Rent asks a second question — which month — so it opens the month
                          // box rather than going straight to a confirm. The default is the day
                          // the bank printed, the same rule the import matcher starts from —
                          // ⚠ but only when the bank date falls in the YEAR on screen. A
                          // December statement can carry a January line: defaulting that to
                          // "January" of the viewed FY would quietly file next year's rent
                          // eleven months early. A line from another year defaults to the
                          // untagged lump instead, and the landlord picks.
                          if (v.startsWith('rent:')) {
                            const sameYear = String(l.txn_date || '').slice(0, 4) === String(year);
                            const m = sameYear ? Number(String(l.txn_date).slice(5, 7)) : 0;
                            setRentPick((p) => ({ ...p, [l.id]: { leaseId: v.slice(5), month: m >= 1 && m <= 12 ? m : null } }));
                            return;
                          }
                          // An ordinary expense asks its own second question — do the tenants
                          // reimburse it? A DISTRIBUTION never does: it is the landlord's own
                          // money on the table the building bills from, kept inert by exactly
                          // that column, so it skips the step rather than offering a choice
                          // that would be refused.
                          if (v.startsWith('expense:') && v !== 'expense:distribution') {
                            setExpensePick((p) => ({
                              ...p,
                              [l.id]: { category: v.slice(8), label: e.target.selectedOptions[0]?.text || 'expense', billable: false },
                            }));
                            return;
                          }
                          askPlace(l, v, e.target.selectedOptions[0]?.text);
                        }}
                        title="Record this line where it belongs. Only “Tenant rent” records money received against a tenant, and only an expense you mark billable moves a tenant's CAM."
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
                        {/* ⚠ RENT FIRST, and until 2026-08-16 it was not offered at all — the
                            one destination the nag could not answer, on the panel whose whole
                            job is giving every bank line a home. Picking a tenant opens the
                            month box beside it, the same pair the import review screen has
                            always had. */}
                        {l.direction === 'in' && derived.length > 0 && (
                          <optgroup label="Tenant rent — from…">
                            {derived.map(({ r }) => (
                              <option key={r.lease_id} value={`rent:${r.lease_id}`}>{r.tenant_name}</option>
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
                      </SelectMenu>
                      {/* ⚠ THE MONTH IS ITS OWN STEP, and it is the point of the request. A
                          cheque that cleared in March can be April's rent, and a tenant can pay
                          twice in one month — so the month defaults to the day the bank printed
                          and is then the landlord's to change, exactly as the import review
                          screen's "For month · editable" column has always worked. "— (lump)"
                          leaves it untagged and the ledger spreads it over the months still owed. */}
                      {rentPick[l.id] && (
                        <span className="line-step">
                          <span className="muted" style={{ fontSize: 11 }}>for</span>
                          <SelectMenu
                            className="text-input" style={{ maxWidth: 92 }}
                            value={rentPick[l.id].month ?? ''}
                            onChange={(e) => setRentPick((p) => ({ ...p, [l.id]: { ...p[l.id], month: e.target.value === '' ? null : Number(e.target.value) } }))}
                            title="Which month's rent this deposit pays — filled in from the date the bank printed, and yours to change. “— (lump)” leaves it untagged and the ledger spreads it across the months still owed."
                          >
                            <option value="">— (lump)</option>
                            {MONTHS.map((nm, mi) => <option key={nm} value={mi + 1}>{nm}</option>)}
                          </SelectMenu>
                          <button type="button" className="ghost btn-sm" disabled={place.isPending}
                            onClick={() => askPlaceRent(l, rentPick[l.id])}>Record</button>
                          <button type="button" className="icon-btn" aria-label="Cancel"
                            onClick={() => setRentPick((p) => { const n = { ...p }; delete n[l.id]; return n; })}>✕</button>
                        </span>
                      )}
                      {/* ⚠ DEFAULT OFF, AND STATED EITHER WAY. This panel's promise has always
                          been that answering the nag cannot move a tenant's bill; the second
                          option breaks that promise deliberately and on purpose, so it is a
                          choice the landlord makes in front of a confirm that says the bills
                          go up — never a silent default. */}
                      {expensePick[l.id] && (
                        <span className="line-step">
                          <SelectMenu
                            className="text-input"
                            value={expensePick[l.id].billable ? 'yes' : 'no'}
                            onChange={(e) => setExpensePick((p) => ({ ...p, [l.id]: { ...p[l.id], billable: e.target.value === 'yes' } }))}
                            title="Is this a cost the tenants reimburse through CAM? Billing it recalculates every tenant's share and rebuilds their invoices for this year; leaving it unbilled means you absorb it."
                          >
                            <option value="no">you absorb it</option>
                            <option value="yes">bill it to tenants as CAM</option>
                          </SelectMenu>
                          <button type="button" className="ghost btn-sm" disabled={place.isPending}
                            onClick={() => askPlaceExpense(l, expensePick[l.id])}>Record</button>
                          <button type="button" className="icon-btn" aria-label="Cancel"
                            onClick={() => setExpensePick((p) => { const n = { ...p }; delete n[l.id]; return n; })}>✕</button>
                        </span>
                      )}
                      <SelectMenu
                        className="text-input"
                        value=""
                        disabled={leaveOut.isPending}
                        onChange={(e) => { if (e.target.value) askLeaveOut(l, e.target.value); }}
                        title="Leave this line out of the ledger, with the reason recorded against it. It stays on record under Decided below."
                      >
                        <option value="">Leave it out…</option>
                        {IGNORE_REASONS.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </SelectMenu>
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
            {/* Same fixed columns as the panel above, so the two lists line up under each
                other and a line moving between them does not shift either one. */}
            <table className="line-table">
              <colgroup>
                <col style={{ width: 78 }} /><col /><col style={{ width: 104 }} /><col style={{ width: 190 }} /><col style={{ width: 120 }} />
              </colgroup>
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
                      <td className="line-desc" title={l.description || ''}>{l.description || '—'}</td>
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
                                else setNote('That statement file is no longer available.', true);
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
