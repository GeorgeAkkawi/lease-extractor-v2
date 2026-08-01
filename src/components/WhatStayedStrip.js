import { useQuery } from '@tanstack/react-query';
import { listCamLineItems, listEntityLedger, listOtherIncome } from '../lib/api';
import { summarizeEntityLedger, absorbedFromItems, whatStayed } from '../lib/entityLedger';
import { summarizeOtherIncome } from '../lib/otherIncome';
import { money } from '../lib/format';

// Slice 4b — the first time the app can show the gap between NOI and what is actually
// in the account.
//
// ⚠ THE TWO WRONG WAYS TO DO THIS, both refused here. Folding the not-billed costs
// into `cam_total` would BILL TENANTS for expenses the landlord deliberately absorbed
// — the exact thing `billable=false` exists to prevent. Redefining
// `v_property_totals.noi` would silently re-value every historical chart point, every
// `financial_snapshots` row already written, and every Ask Amlak fact. So NOI is
// quoted unchanged and everything it doesn't know about is carried BESIDE it, derived
// client-side from data that already exists.
//
// Both queries reuse the exact keys their own screens use — `camLineItems` is the
// same key CamSection and RecoverabilityTable read — so this is normally a cache hit,
// it repaints on every existing invalidation, and it cannot disagree with the panels
// below it.
export default function WhatStayedStrip({ propId, year, noi }) {
  const { data: camItems = [] } = useQuery({
    queryKey: ['camLineItems', propId, year],
    queryFn: () => listCamLineItems(propId, year),
  });
  const { data: entries = [] } = useQuery({
    queryKey: ['entityLedger', propId, year],
    queryFn: () => listEntityLedger({ propertyId: propId, year }),
  });

  // Slice 4c fills the slot round 7 built and left empty: income the property really
  // received that NOI has never counted, because it never rode an invoice.
  const { data: income = [] } = useQuery({
    queryKey: ['otherIncome', propId, year],
    queryFn: () => listOtherIncome(propId, year),
  });

  const absorbed = absorbedFromItems(camItems);
  const sum = summarizeEntityLedger(entries);
  const inc = summarizeOtherIncome(income);
  const { lines, stayed } = whatStayed({
    noi,
    absorbed: absorbed.total,
    otherIncome: inc.total,
    draws: sum.draws,
    contributions: sum.contributions,
    entityCosts: sum.costs,
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
          {sum.draws > 0 && ' A draw is not an expense — it reduces your equity, so it is subtracted here and nowhere else.'}
          {inc.count > 0 && ` Other income is real money in, but it never rode a tenant's invoice — so no Collected figure includes it.`}
        </div>
      </div>
    </div>
  );
}
