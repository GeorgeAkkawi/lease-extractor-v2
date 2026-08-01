// Slice 4c — the security deposit, and the cross-check nobody else can run.
//
// A security deposit is a LIABILITY, never income. It is the tenant's money, held, and
// returned or applied at move-out. Booked as rent — which was its only possible
// destination before this round — a $5,000 deposit credits that tenant's annual
// invoice, so `allocatePayments` reads months as over-paid and the Ledger's Collected
// column reports rent that was never collected. That is the single most corrupting
// thing a bank line could do to a figure the landlord trusts.
//
// TWO SOURCES, DELIBERATELY KEPT SEPARATE.
//   * `leases.security_deposit` — what the LEASE SAYS is held. A term, read by the
//     extractor or typed by hand. This is the record.
//   * bank lines with disposition 'deposit_held' pointing at that lease — what the
//     BANK SHOWS arrived. This is corroboration.
//
// Neither is derived from the other, and that is the point: Amlak holds the document
// AND the money, so when they disagree it can say so. QuickBooks has the money and not
// the lease; a lease-abstraction tool has the lease and not the money.
//
// ⚠ DISAGREEMENT IS NOT AUTOMATICALLY A PROBLEM, and reporting it as one would train
// George to ignore it. A deposit taken in 2019 has no bank line in Amlak and never
// will — that is the overwhelmingly common case, so it reads as a plain statement of
// fact, not a warning. The genuinely interesting case is the reverse: money arrived and
// the lease records no deposit at all.

// The 0055 dust convention — a few cents is rounding, not a discrepancy.
const DUST = 0.05;
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const money = (n) => `$${round2(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Sum the bank lines that were placed as this lease's security deposit. 0076 records
// every transcribed line with a disposition and a `ref`, so a deposit line pointing at
// its lease IS the record — no third table, and therefore no third figure that can
// start disagreeing with the other two.
export function depositLinesFor(lines = [], leaseId) {
  if (!leaseId) return [];
  return (lines || []).filter((l) => l?.disposition === 'deposit_held' && l?.ref_id === leaseId);
}

// The verdict. `stated` = leases.security_deposit; `lines` = that lease's deposit lines.
// Returns { state, stated, received, difference, tone, sentence } — tone is the app's
// badge vocabulary ('good' | 'warn' | null), null meaning "say it plainly, don't flag it".
export function depositReconciliation({ stated, lines = [] } = {}) {
  const hasStated = stated != null && stated !== '' && isFinite(Number(stated));
  const statedAmt = hasStated ? round2(stated) : null;
  const received = round2((lines || []).reduce((n, l) => n + Math.abs(Number(l?.amount) || 0), 0));
  const hasReceived = (lines || []).length > 0;
  const base = { stated: statedAmt, received, count: (lines || []).length };

  if (!hasStated && !hasReceived) {
    return { ...base, state: 'none', difference: 0, tone: null, sentence: '' };
  }

  // Money arrived and the lease records no deposit. THE case worth surfacing: either
  // the lease term was never captured, or that money is not a deposit at all — and if
  // it isn't, it is sitting in no income figure anywhere.
  if (!hasStated && hasReceived) {
    return {
      ...base, state: 'received_only', difference: received, tone: 'warn',
      sentence: `${money(received)} was recorded as a deposit from this tenant, but the lease has no deposit on file. Enter what the lease says is held, or re-place that bank line.`,
    };
  }

  // The lease states one and no bank line records it. Overwhelmingly the normal case —
  // the deposit was taken before Amlak, or that month was never imported. Stated as a
  // fact, deliberately NOT flagged.
  if (hasStated && !hasReceived) {
    return {
      ...base, state: 'stated_only', difference: 0, tone: null,
      sentence: `No bank line has been recorded against it — normal if it was taken before you started importing statements.`,
    };
  }

  const difference = round2(received - statedAmt);
  if (Math.abs(difference) <= DUST) {
    return {
      ...base, state: 'matched', difference: 0, tone: 'good',
      sentence: `${money(received)} received — matches the lease.`,
    };
  }
  return {
    ...base, state: difference > 0 ? 'over' : 'short', difference, tone: 'warn',
    sentence: difference > 0
      ? `${money(received)} was received against a stated deposit of ${money(statedAmt)} — ${money(Math.abs(difference))} more than the lease says is held.`
      : `${money(received)} has been recorded against a stated deposit of ${money(statedAmt)} — ${money(Math.abs(difference))} short of what the lease says is held.`,
  };
}

// Portfolio/property-level: what you are holding that is not yours. A liability, so it
// appears in no income figure and no expense figure — only in what you owe.
export function totalDepositsHeld(leases = []) {
  let total = 0;
  let count = 0;
  for (const l of leases || []) {
    const amt = Number(l?.security_deposit);
    if (!isFinite(amt) || amt <= 0) continue;
    total = round2(total + amt);
    count += 1;
  }
  return { total, count };
}
