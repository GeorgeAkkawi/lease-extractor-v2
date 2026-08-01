import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listFixedAssets, addFixedAsset, deleteFixedAsset, setFixedAssetLand, setAssetAmortization } from '../lib/api';
import {
  ASSET_KINDS, assetKindInfo, assetKindLabel, summarizeAssets, priorCheck, DEFAULT_LIFE_NOTE,
  amortizationFor, canAmortize,
} from '../lib/depreciation';
import { settleBillingChange } from '../lib/invalidate';
import { money, fmtShortDate } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';

// Slice 5a — the things this property owns, and what they lose in value each year.
//
// ⚠ THE DEPRECIATION ITSELF MOVES NO DOLLAR. It never crossed the bank: no expense total
// changes, no tenant is billed, and it appears in no cash figure — including, deliberately,
// "What actually stayed" above, which answers what is in the account. Every row lives in
// `fixed_assets`, which no view, no invoice and no share calculation reads.
//
// ⚠ EXACTLY ONE CONTROL HERE IS DIFFERENT, and Slice 5b added it: billing a capitalized
// cost back to tenants over its life writes a REAL expense line. That is opt-in, confirmed
// with the consequence named, and carries the full §1 chain. Everything else on this panel
// is still inert.
//
// ⚠ AND RECORDING AN ASSET STILL DOES NOT REMOVE IT FROM YOUR EXPENSES. A roof entered
// here while the same roof sits in this year's roof total is counted twice — the fix is
// the ⤴ Capitalize control on the expense line itself, which moves the cost rather than
// copying it. The footer says so rather than letting the double-count go unnamed.
export default function AssetRegisterSection({ propId, year }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editLand, setEditLand] = useState(null);
  const [landDraft, setLandDraft] = useState('');
  const [amortNote, setAmortNote] = useState(null);
  const blank = {
    kind: 'improvement', description: '', placed_in_service: '', cost: '',
    land_cost: '', useful_life_years: '', prior_accumulated: '', prior_accumulated_year: '',
  };
  const [form, setForm] = useState(blank);

  const { data: assets = [] } = useQuery({
    queryKey: ['fixedAssets', propId],
    queryFn: () => listFixedAssets(propId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['fixedAssets'] });

  const add = useMutation({
    mutationFn: (f) => addFixedAsset({ ...f, property_id: propId }),
    onSuccess: () => { setAdding(false); setForm(blank); invalidate(); },
  });
  const remove = useMutation({ mutationFn: (id) => deleteFixedAsset(id), onSuccess: invalidate });
  const setLand = useMutation({
    mutationFn: ({ id, land_cost }) => setFixedAssetLand(id, land_cost),
    onSuccess: () => { setEditLand(null); setLandDraft(''); invalidate(); },
  });

  // ⚠ Slice 5b — THE ONE MUTATION ON THIS PANEL THAT MOVES A TENANT'S BILL. Everything
  // else here is non-cash and reaches no total; switching amortization on writes a real
  // expense line that tenants are charged pro-rata. So it carries the full billing
  // settle, and the confirm below names the consequence before it fires.
  const setAmort = useMutation({
    mutationFn: ({ id, into }) => setAssetAmortization(id, into, propId, year),
    onSuccess: (res) => {
      // ⚠ A closed year's bills are frozen, so no charge is written into it. The asset
      // still amortizes — the charge simply starts from the next open year — and saying
      // that is better than a chip that reads "billed back · $0.00 this year".
      setAmortNote(res?.skipped === 'closed'
        ? `FY ${year} is closed, so nothing was billed into it. The charge starts from the next open year.`
        : null);
      invalidate();
      qc.invalidateQueries({ queryKey: ['camLineItems', propId, year] });
      qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
      settleBillingChange(qc, { propertyId: propId, year });
    },
  });

  // ⚠ WHICH CHARGE IT GOES BACK THROUGH IS PICKED, NEVER INFERRED — and that is the
  // whole correction this round makes. "Building improvement" covers a roof AND a lobby
  // renovation; a roof must bill through the roof charge so only roof-responsible leases
  // pay it, while a lobby belongs in CAM where everyone does. Guessing from the kind
  // would put roughly $17,000 of an $18,000 roof onto eight Pershing tenants whose
  // leases exclude it. (An asset capitalized off an expense line already knows, because
  // it inherits the kind of the line it came from.)
  async function chooseAmortize(row, calc, into) {
    if (!into) {
      const ok = await askConfirm({
        title: 'Stop billing this back?',
        message: `${row.description || assetKindLabel(row.kind)} — currently ${money(calc.thisYear || 0)} a year.`,
        implications: [
          'The amortized line comes off this year’s expenses, so tenants are billed less.',
          'The asset and its depreciation schedule are unchanged — only the charge to tenants stops.',
          'Your invoices for this year are re-issued at the new figures.',
        ],
        confirmLabel: 'Stop billing it back',
        tone: 'warn',
      });
      if (ok) setAmort.mutate({ id: row.id, into: null });
      return;
    }
    const perYear = calc.annual || calc.thisYear || 0;
    const ok = await askConfirm({
      title: 'Bill this back to tenants?',
      message: `${row.description || assetKindLabel(row.kind)} — ${money(row.cost)} over ${calc.life} years.`,
      implications: [
        `${money(perYear)} a year is added to your ${into === 'roof' ? 'roof' : 'CAM'} expenses and billed to tenants.`,
        into === 'roof'
          ? 'It goes through the roof charge, so only leases whose terms make them responsible for the roof pay it.'
          : 'It goes through CAM, so every tenant pays a pro-rata share by square footage.',
        'This year’s figure is prorated to the months it was actually in service.',
        // The honest limit, stated where the decision is made.
        'Amlak can’t tell whether your leases permit recovering capital costs — check the clause before switching this on.',
      ],
      confirmLabel: 'Bill it back',
      tone: 'warn',
    });
    if (ok) setAmort.mutate({ id: row.id, into });
  }

  const sum = summarizeAssets(assets, year);
  const formKind = assetKindInfo(form.kind);
  // The life is pre-filled from the kind and always overridable — so a residential
  // landlord types 27.5 and the schedule follows, rather than being told 39 is the answer.
  const effectiveLife = form.useful_life_years === '' ? formKind.life : Number(form.useful_life_years);

  async function confirmRemove(row) {
    const ok = await askConfirm({
      title: 'Remove this asset?',
      message: `${row.description || assetKindLabel(row.kind)} — ${money(row.cost)}.`,
      implications: [
        'Its depreciation schedule goes with it — this year’s figure and everything already taken.',
        'No expense total, no tenant’s bill and no cash figure changes — this row never fed any of them.',
      ],
      confirmLabel: 'Remove',
      tone: 'danger',
    });
    if (ok) remove.mutate(row.id);
  }

  // The forcing function, in the app's own "look here" colour. A building with no land
  // allocation does not depreciate at all, and it says exactly why rather than quietly
  // reporting $0 — which would look identical to a fully-depreciated asset.
  const landChip = (row) => {
    if (editLand === row.id) {
      return (
        <span className="row" style={{ gap: 6, alignItems: 'center', marginTop: 4 }}>
          <input
            className="text-input" style={{ maxWidth: 130, fontSize: 12 }} type="number" step="0.01"
            autoFocus placeholder="Land value" value={landDraft}
            onChange={(e) => setLandDraft(e.target.value)}
          />
          <button type="button" className="btn-sm" disabled={landDraft === '' || setLand.isPending}
            onClick={() => setLand.mutate({ id: row.id, land_cost: landDraft })}>Save</button>
          <button type="button" className="secondary btn-sm" onClick={() => { setEditLand(null); setLandDraft(''); }}>Cancel</button>
        </span>
      );
    }
    return (
      <button
        type="button"
        className="cat-chip none"
        onClick={() => { setEditLand(row.id); setLandDraft(row.land_cost == null ? '' : String(row.land_cost)); }}
        title="Land never wears out, so it never depreciates. The split is a decision — your closing statement or the county assessor’s ratio is where it comes from. Amlak will not guess it."
      >
        Set the land value
      </button>
    );
  };

  return (
    <div className="panel">
      <div className="panel-head">
        <strong>What you own · FY {year}</strong>
        <button type="button" className="secondary btn-sm" onClick={() => setAdding((v) => !v)}>
          {adding ? 'Cancel' : '＋ Record one'}
        </button>
      </div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 10 }}>
        The building and everything bought once and used for years — a roof, a parking lot, an HVAC
        unit. Each loses value over its life on a straight line, so a single big year stops reading
        as a disaster. <strong>None of this is cash</strong>: no money leaves your account and no
        tenant is billed.
      </div>

      {adding && (
        <div style={{ marginBottom: 14 }}>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
            <select
              className="text-input" style={{ maxWidth: 230 }} value={form.kind}
              onChange={(e) => setForm({ ...form, kind: e.target.value, useful_life_years: '' })}
            >
              {ASSET_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
            <input className="text-input" style={{ maxWidth: 210 }} placeholder="What it was (optional)"
              value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            <input className="text-input" style={{ maxWidth: 140 }} type="number" step="0.01" placeholder="Cost"
              value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} />
            <input className="text-input" style={{ maxWidth: 155, minWidth: 0 }} type="date"
              title="The date it went into service"
              value={form.placed_in_service} onChange={(e) => setForm({ ...form, placed_in_service: e.target.value })} />
            {formKind.landSplit && (
              <input className="text-input" style={{ maxWidth: 150 }} type="number" step="0.01" placeholder="Of which, land"
                title="Land never depreciates, so its value comes out first. Your closing statement or the county assessor’s ratio is where this comes from."
                value={form.land_cost} onChange={(e) => setForm({ ...form, land_cost: e.target.value })} />
            )}
            <input className="text-input" style={{ maxWidth: 120 }} type="number" step="0.5"
              placeholder={formKind.life ? `Life — ${formKind.life} yr` : 'Life (years)'}
              value={form.useful_life_years} onChange={(e) => setForm({ ...form, useful_life_years: e.target.value })} />
            <button type="button" className="btn-sm"
              disabled={!(Number(form.cost) > 0) || !form.placed_in_service || !(effectiveLife > 0) || add.isPending}
              onClick={() => add.mutate(form)}>Add</button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
            {formKind.hint} {formKind.life ? DEFAULT_LIFE_NOTE : ''}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
            <input className="text-input" style={{ maxWidth: 200 }} type="number" step="0.01"
              placeholder="Already depreciated (optional)"
              value={form.prior_accumulated} onChange={(e) => setForm({ ...form, prior_accumulated: e.target.value })} />
            <input className="text-input" style={{ maxWidth: 120 }} type="number" placeholder="Through year"
              value={form.prior_accumulated_year} onChange={(e) => setForm({ ...form, prior_accumulated_year: e.target.value })} />
            <span className="muted" style={{ fontSize: 11 }}>
              From your accountant’s last schedule, if you have one. It is checked against this one — never used instead of it.
            </span>
          </div>
        </div>
      )}

      {!assets.length && !adding && (
        <p className="muted" style={{ fontSize: 12 }}>
          Nothing recorded yet. The building itself is the place to start — its cost, the date you
          bought it, and how much of that was the land.
        </p>
      )}

      {!!assets.length && (
        <div className="asset-table">
          <div className="asset-row asset-th">
            <div>Asset</div>
            <div className="num">Cost</div>
            <div className="num">FY {year}</div>
            <div className="num">Taken to date</div>
            <div className="num">Book value</div>
            <div />
          </div>

          {sum.rows.map(({ asset: a, calc }) => {
            const prior = priorCheck(a);
            const needsLand = calc.blocked && assetKindInfo(a.kind).landSplit && a.land_cost == null;
            return (
              <div className={`asset-row${calc.blocked ? ' asset-blocked' : ''}`} key={a.id}>
                <div>
                  {a.description || assetKindLabel(a.kind)}
                  <div className="cell-sub">
                    {assetKindLabel(a.kind)}
                    {a.placed_in_service ? ` · in service ${fmtShortDate(a.placed_in_service)}` : ''}
                    {calc.life ? ` · ${calc.life} yr` : ''}
                    {a.land_cost != null && Number(a.land_cost) > 0 ? ` · land ${money(a.land_cost)}` : ''}
                  </div>
                  {needsLand && <div>{landChip(a)}</div>}
                  {!!prior.sentence && (
                    <div className={`asset-note${prior.tone === 'warn' ? ' warn-sub' : ''}`}>{prior.sentence}</div>
                  )}
                  {calc.blocked && !needsLand && (
                    <div className="asset-note">Not depreciating — {calc.reason}.</div>
                  )}
                  {/* Slice 5b — the only thing on this panel that reaches a tenant's
                      bill, so it states what it is doing on the row rather than hiding
                      behind a toggle. Offered only where a lease could support it: the
                      building itself and its acquisition costs are never a CAM item. */}
                  {!calc.blocked && canAmortize(a) && (
                    <div className="asset-amort">
                      {a.amortize_into ? (
                        <>
                          <span className="badge info" title="Billed back to tenants through this charge, spread over the asset's life.">
                            billed back · {a.amortize_into === 'roof' ? 'roof' : 'CAM'}
                          </span>
                          <span className="muted"> {money(amortizationFor(a, year)?.amount || 0)} this year</span>
                          <button type="button" className="ghost btn-sm" onClick={() => chooseAmortize(a, calc, null)}>Stop</button>
                        </>
                      ) : (
                        <>
                          <span className="muted">Not billed back.</span>
                          <button type="button" className="ghost btn-sm" onClick={() => chooseAmortize(a, calc, 'cam')} title="Adds this year's share to CAM — every tenant pays a pro-rata share by square footage.">Bill through CAM</button>
                          <button type="button" className="ghost btn-sm" onClick={() => chooseAmortize(a, calc, 'roof')} title="Adds this year's share to the roof charge — only leases whose terms make them responsible for the roof pay it.">…or roof</button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                <div className="num"><span className="stat-label">Cost</span>{money(a.cost)}</div>
                <div className="num asset-year">
                  <span className="stat-label">FY {year}</span>
                  {calc.blocked ? '—' : money(calc.thisYear)}
                </div>
                <div className="num asset-back">
                  <span className="stat-label">Taken to date</span>
                  {calc.blocked ? '—' : money(calc.accumulated)}
                </div>
                <div className="num asset-book">
                  <span className="stat-label">Book value</span>
                  {calc.blocked ? money(a.cost) : money(calc.bookValue)}
                </div>
                <button className="icon-btn danger-btn" onClick={() => confirmRemove(a)}>✕</button>
              </div>
            );
          })}

          {/* Summed from the ROWS SHOWN, never derived a second way, so the table can
              never disagree with its own arithmetic. */}
          <div className="asset-row asset-total">
            <div className="muted">
              {sum.count} asset{sum.count === 1 ? '' : 's'}
              {sum.blocked > 0 ? ` · ${sum.blocked} not depreciating yet` : ''}
            </div>
            <div className="num"><b>{money(sum.cost)}</b></div>
            <div className="num"><b>{money(sum.thisYear)}</b></div>
            <div className="num asset-back"><b>{money(sum.accumulated)}</b></div>
            <div className="num asset-book"><b>{money(sum.bookValue)}</b></div>
            <div />
          </div>
        </div>
      )}

      {sum.count > 0 && (
        <div className="muted" style={{ fontSize: 11, marginTop: 12 }}>
          {money(sum.thisYear)} of depreciation for FY {year}. It is a <strong>non-cash</strong>{' '}
          figure — nothing left your account, so it is deliberately absent from “What actually
          stayed” above, which counts only money that moved. Straight-line and book only: your
          accountant applies the conventions and elections Amlak does not compute.
          {' '}Recording an asset here does <strong>not</strong> remove it from your expenses — if the
          same cost is still sitting in this year’s CAM or roof total, it is counted twice. Use
          <strong> ⤴ Capitalize</strong> on the expense line itself to move it instead of copying it.
        </div>
      )}
      {amortNote && <div className="note-msg warn" style={{ marginTop: 10 }}>{amortNote}</div>}
      <MutationError of={[add, remove, setLand, setAmort]} />
    </div>
  );
}
