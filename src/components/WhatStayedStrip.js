import { useQuery } from '@tanstack/react-query';
import { listCamLineItems, listOtherIncome, listExpenseBuckets } from '../lib/api';
import { absorbedFromItems, whatStayed } from '../lib/recoverability';
import { summarizeOtherIncome } from '../lib/otherIncome';
import { money } from '../lib/format';

// The gap between NOI and what is actually in the account.
//
// ⚠ THE TWO WRONG WAYS TO DO THIS, both refused here. Folding the not-billed costs
// into `cam_total` would BILL TENANTS for expenses the landlord deliberately absorbed
// — the exact thing `billable=false` exists to prevent. Redefining
// `v_property_totals.noi` would silently re-value every historical chart point, every
// `financial_snapshots` row already written, and every Ask Amlak fact. So NOI is
// quoted unchanged and everything it doesn't know about is carried BESIDE it, derived
// client-side from data that already exists.
//
// Every query reuses the exact key its own screen uses — `camLineItems` is the same key
// CamSection and RecoverabilityTable read, `expenseBuckets` the same key CamSection's
// category chips read — so this is normally three cache hits, it repaints on every
// existing invalidation, and it cannot disagree with the panels below it.
//
// The arithmetic is UNCHANGED by the entity ledger's retirement (2026-08-12). A draw
// used to arrive as an `entity_ledger` row and now arrives as a non-billable expense
// line carrying the `distribution` category; `absorbedFromItems` splits it back out by
// category, so the same dollars are subtracted under the same label as before.
export default function WhatStayedStrip({ propId, year, noi }) {
  const { data: camItems = [] } = useQuery({
    queryKey: ['camLineItems', propId, year],
    queryFn: () => listCamLineItems(propId, year),
  });
  // What resolves a non-billable line's category, and so which side of the strip it
  // lands on — a cost you ate, or money you took out.
  const { data: buckets = [] } = useQuery({ queryKey: ['expenseBuckets'], queryFn: listExpenseBuckets });

  // Income the property really received that NOI has never counted, because it never
  // rode an invoice.
  const { data: income = [] } = useQuery({
    queryKey: ['otherIncome', propId, year],
    queryFn: () => listOtherIncome(propId, year),
  });

  const absorbed = absorbedFromItems(camItems, buckets);
  const inc = summarizeOtherIncome(income);
  const { lines, stayed } = whatStayed({
    noi,
    absorbed: absorbed.total,
    otherIncome: inc.total,
    distributions: absorbed.ownerTotal,
  });

  // Nothing to reconcile means nothing to show: a strip that reads "NOI $150,837 =
  // what stayed $150,837" is a row of noise claiming to be a finding.
  if (lines.length < 2) return null;

  return (
    <div className="metric-group">
      <div className="fin-subhead">What actually stayed · FY {year}</div>
      <div className="panel stayed-strip">
        {lines.map((l) => (
          <div className={`stayed-row${l.key === 'noi' ? ' stayed-start' : ''}`} key={l.key}>
            <div>
              <span className="stayed-op">{l.key === 'noi' ? '' : l.sign > 0 ? '+' : '−'}</span>
              {l.label}
              <div className="muted" style={{ fontSize: 11 }}>{l.sub}</div>
            </div>
            <div className="num">{money(l.amount)}</div>
          </div>
        ))}
        <div className="stayed-row stayed-total">
          <div><strong>What actually stayed</strong></div>
          <div className="num"><b>{money(stayed)}</b></div>
        </div>
        <div className="muted" style={{ fontSize: 11, marginTop: 10 }}>
          NOI is unchanged — it is what your tenants were billed, less what the building spent.
          Everything under it is real money that NOI has never known about
          {absorbed.count > 0 && <>, including {absorbed.count} expense line{absorbed.count === 1 ? '' : 's'} you entered and chose not to bill back</>}.
          {absorbed.ownerTotal > 0 && ' A distribution is not an expense — it reduces your equity, so it is subtracted here and left out of every expense total.'}
          {inc.count > 0 && ` Other income is real money in, but it never rode a tenant's invoice — so no Collected figure includes it.`}
        </div>
      </div>
    </div>
  );
}
