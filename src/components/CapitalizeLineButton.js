import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { capitalizeExpenseLine } from '../lib/api';
import { ASSET_KINDS, assetKindInfo } from '../lib/depreciation';
import { settleBillingChange } from '../lib/invalidate';
import { money, fmtShortDate } from '../lib/format';
import { useConfirm } from './ConfirmDialog';

// Slice 5b — turn an expense line into an asset, from the list it is sitting in.
//
// ⚠ THIS IS THE ONE CONTROL IN THE ACCOUNTING ARC THAT DELIBERATELY MOVES A TENANT'S
// BILL. Round 9 could record an $18,000 roof in the asset register but could not take it
// out of the year's roof_total, so a landlord who did both told the app about the same
// roof twice. This is the other half — and because roof_total feeds v_property_totals,
// which feeds every roof-responsible lease's roof_amt, removing it lowers what those
// tenants are billed. The confirm says so in those words before anything happens.
//
// Shared by the CAM list and the roof list rather than written twice: two copies of a
// control that moves money is exactly how the two drift into disagreeing.
export const CAPITALIZE_FLOOR = 2500;

// Which asset kind a line most likely becomes, from the list it was sitting in. A roof
// line is a building improvement; a CAM line could be either, so it opens on the
// improvement and the landlord picks. A suggestion, never an answer.
const kindGuess = (item) => {
  const label = String(item?.label || '').toLowerCase();
  if (/parking|lot|paving|asphalt|fence|fencing|landscap|lighting/.test(label)) return 'land_improvement';
  if (/sign|camera|security system|machine/.test(label)) return 'equipment';
  return 'improvement';
};

export default function CapitalizeLineButton({ item, propId, year, onDone }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState(() => kindGuess(item));
  const [life, setLife] = useState('');
  const [placed, setPlaced] = useState(item?.paid_date || '');
  const [amortize, setAmortize] = useState(false);
  const [note, setNote] = useState(null);

  const info = assetKindInfo(kind);
  const effectiveLife = life === '' ? info.life : Number(life);
  const cost = Number(item?.amount) || 0;
  const perYear = effectiveLife > 0 ? Math.round((cost / effectiveLife) * 100) / 100 : 0;
  // Which expense kind it would bill back into — the same one it is leaving, so the same
  // tenants pay. A roof returns to roof (only roof-responsible leases); a CAM line
  // returns to CAM (everyone, pro-rata).
  const backInto = item?.kind === 'roof' ? 'roof' : 'cam';

  const run = useMutation({
    mutationFn: () => capitalizeExpenseLine(item.id, {
      kind,
      placed_in_service: placed || null,
      useful_life_years: life === '' ? null : Number(life),
      amortize,
    }),
    onSuccess: (res) => {
      if (res?.skipped === 'closed') {
        setNote('This fiscal year is closed — the bills for it have already been sent, so the expense can’t be moved out of it now. Record the asset by hand in “What you own” and leave this line where it is.');
        return;
      }
      if (res?.skipped === 'no_date') {
        setNote('This line has no date paid, so there’s no date to start the schedule from. Add one to the line first.');
        return;
      }
      setOpen(false);
      setNote(null);
      qc.invalidateQueries({ queryKey: ['camLineItems', propId, year] });
      qc.invalidateQueries({ queryKey: ['expenseLineItems', propId, year] });
      qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
      qc.invalidateQueries({ queryKey: ['fixedAssets', propId] });
      settleBillingChange(qc, { propertyId: propId, year });
      onDone?.(res);
    },
  });

  async function confirmRun() {
    const implications = [
      `${money(cost)} stops being a ${year} expense and becomes an asset worth ${money(cost)} on the books.`,
      // The consequence that matters, named in the direction it actually cuts.
      item?.kind === 'roof'
        ? `This year’s roof total drops by ${money(cost)}, so every tenant whose lease makes them responsible for the roof is billed less.`
        : `This year’s CAM total drops by ${money(cost)}, so every tenant’s pro-rata CAM share is billed less.`,
      amortize
        ? `${money(perYear)} a year goes back into ${backInto === 'roof' ? 'the roof total' : 'CAM'} for ${effectiveLife} years — the same tenants, spread over the life instead of landed in one year.`
        : 'Nothing is billed back to tenants. You can switch that on later from “What you own”.',
      'Your invoices for this year are re-issued at the new figures.',
    ];
    const ok = await askConfirm({
      title: 'Capitalize this cost?',
      message: `${item.label} — ${money(cost)}, paid ${item.paid_date ? fmtShortDate(item.paid_date) : 'this year'}.`,
      implications,
      confirmLabel: 'Capitalize',
      tone: 'warn',
    });
    if (ok) run.mutate();
  }

  if (!open) {
    return (
      <button
        type="button"
        className="ghost btn-sm"
        onClick={() => setOpen(true)}
        title="Bought once and used for years? Record it as an asset instead of a single year’s expense."
      >
        ⤴ Capitalize
      </button>
    );
  }

  return (
    <div className="capitalize-form">
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="text-input" style={{ maxWidth: 210 }} value={kind}
          onChange={(e) => { setKind(e.target.value); setLife(''); }}>
          {ASSET_KINDS.filter((k) => k.amortizable).map((k) => (
            <option key={k.key} value={k.key}>{k.label}</option>
          ))}
        </select>
        <input className="text-input" style={{ maxWidth: 120 }} type="number" step="0.5"
          placeholder={info.life ? `Life — ${info.life} yr` : 'Life (years)'}
          value={life} onChange={(e) => setLife(e.target.value)} />
        <input className="text-input" style={{ maxWidth: 155, minWidth: 0 }} type="date"
          title="The date it went into service" value={placed}
          onChange={(e) => setPlaced(e.target.value)} />
        <button type="button" className="btn-sm" disabled={!placed || !(effectiveLife > 0) || run.isPending}
          onClick={confirmRun}>Capitalize</button>
        <button type="button" className="secondary btn-sm" onClick={() => { setOpen(false); setNote(null); }}>Cancel</button>
      </div>
      <label className="row" style={{ gap: 6, alignItems: 'center', marginTop: 8, fontSize: 12 }}>
        <input type="checkbox" checked={amortize} onChange={(e) => setAmortize(e.target.checked)} />
        <span>
          Bill it back to tenants at <strong>{money(perYear)}</strong> a year for {effectiveLife || '—'} years
          {' '}(through {backInto === 'roof' ? 'the roof charge, so only roof-responsible tenants pay' : 'CAM, pro-rata by square footage'})
        </span>
      </label>
      <div className="muted" style={{ fontSize: 11, marginTop: 6, maxWidth: '58ch', lineHeight: 1.4 }}>
        {info.hint}{' '}
        {/* The refusal that keeps this honest: whether a lease PERMITS a capital cost to
            be amortized into the operating charges is a lease question, and Amlak has the
            documents but not a stored answer. So it is off unless the landlord says
            otherwise — the cam_capped problem with the sign flipped. */}
        Only tick the box if the leases let you recover capital costs — Amlak doesn’t assume they do.
      </div>
      {note && <div className="note-msg warn" style={{ marginTop: 8 }}>{note}</div>}
      {run.isError && <div className="note-msg danger" style={{ marginTop: 8 }}>{String(run.error?.message || run.error)}</div>}
    </div>
  );
}
