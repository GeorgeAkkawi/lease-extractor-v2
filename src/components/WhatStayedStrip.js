import { useQuery } from '@tanstack/react-query';
import { listOtherIncome } from '../lib/api';
import { absorbedFromItems, whatStayed } from '../lib/recoverability';
import useRecoverability from '../lib/useRecoverability';
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
// Every query reuses the exact key its own screen uses, so this is normally all cache hits,
// it repaints on every existing invalidation, and it cannot disagree with the panels below
// it. Since 2026-08-21 the expense side comes through `useRecoverability` — the SAME loader
// *What it cost you* uses — because both panels now print the reimbursement and two
// assemblies of one figure is the §3 drift that puts two of them on one page.
//
// ⚠ AND NOI IS STRUCK BEFORE THAT REIMBURSEMENT. `v_property_totals.noi` is
// `Σ effective_rent − (taxes + cam + roof)` (migration 0049): base rent in, GROSS expenses
// out. In a triple-net lease those expenses are cancelled by what the tenant pays back, so
// NOI understates by exactly that — on every NNN property, every year. This strip carried
// the understatement silently until George named it; the workbook never did, because
// `noiBridge` has always had a "tenants reimbursed" term.
//
// The arithmetic is UNCHANGED by the entity ledger's retirement (2026-08-12). A draw
// used to arrive as an `entity_ledger` row and now arrives as a non-billable expense
// line carrying the `distribution` category; `absorbedFromItems` splits it back out by
// category, so the same dollars are subtracted under the same label as before.
export default function WhatStayedStrip({ propId, year, noi }) {
  // ⚠ THE SAME LOADER *What it cost you* USES, so "Tenants reimbursed" here and "Recovered
  // from tenants" there are one figure, including the `escReady` weighting gate. Two
  // assemblies of the same inputs on one page is the §3 drift that puts two reimbursement
  // totals in front of an accountant.
  const { totals, items, buckets } = useRecoverability(propId, year);

  // Income the property really received that NOI has never counted, because it never
  // rode an invoice.
  const { data: income = [] } = useQuery({
    queryKey: ['otherIncome', propId, year],
    queryFn: () => listOtherIncome(propId, year),
  });

  // ⚠ ALL THREE KINDS, not CAM alone. This read `absorbedFromItems(camItems, buckets)` until
  // 2026-08-21, so a not-billed TAX or ROOF line was money that left the account and that this
  // strip never subtracted — the same class of omission as the missing reimbursement, on the
  // other side of the ledger. `items` is the tax+cam+roof array the recoverability table
  // already builds.
  const absorbed = absorbedFromItems(items, buckets);
  const inc = summarizeOtherIncome(income);
  const { lines, stayed } = whatStayed({
    noi,
    recovered: totals.recovered,
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
          {/* ⚠ THIS SENTENCE USED TO BE WRONG, and being wrong is what hid the omission: it read
              "NOI is unchanged — it is what your tenants were billed, less what the building
              spent." NOI is what tenants were billed FOR RENT, less the gross expense — the
              reimbursement is in neither half of it. */}
          NOI is unchanged — it is your tenants’ <strong>rent</strong>, less what the building spent.
          It is struck before they pay any of that back, which is why the reimbursement is added
          here rather than hidden inside it. Everything under NOI is real money it has never known about
          {absorbed.count > 0 && <>, including {absorbed.count} expense line{absorbed.count === 1 ? '' : 's'} you entered and chose not to bill back</>}.
          {absorbed.ownerTotal > 0 && ' A distribution is not an expense — it reduces your equity, so it is subtracted here and left out of every expense total.'}
          {inc.count > 0 && ` Other income is real money in, but it never rode a tenant's invoice — so no Collected figure includes it.`}
        </div>
      </div>
    </div>
  );
}
