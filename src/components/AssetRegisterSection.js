import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { listFixedAssets, addFixedAsset, deleteFixedAsset, setFixedAssetLand } from '../lib/api';
import {
  ASSET_KINDS, assetKindInfo, assetKindLabel, summarizeAssets, priorCheck, DEFAULT_LIFE_NOTE,
} from '../lib/depreciation';
import { money, fmtShortDate } from '../lib/format';
import MutationError from './MutationError';
import { useConfirm } from './ConfirmDialog';

// Slice 5a — the things this property owns, and what they lose in value each year.
//
// ⚠ NOTHING ON THIS PANEL MOVES A DOLLAR. Depreciation never crossed the bank: no
// expense total changes, no tenant is billed, and it appears in no cash figure —
// including, deliberately, "What actually stayed" above, which answers what is in the
// account. Every row lives in `fixed_assets`, which no view, no invoice and no share
// calculation reads.
//
// ⚠ AND IT DOES NOT REMOVE ANYTHING FROM YOUR EXPENSES. Recording a roof here while the
// same roof sits in this year's roof total counts it twice. Taking it OUT of the
// expense — and amortizing it back into CAM — is a real billing change that has to run
// the full carry-through, which is Slice 5b. So the panel says so on its face rather
// than letting the double-count go unnamed.
export default function AssetRegisterSection({ propId, year }) {
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const [adding, setAdding] = useState(false);
  const [editLand, setEditLand] = useState(null);
  const [landDraft, setLandDraft] = useState('');
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
          {' '}Recording an asset here does <strong>not</strong> remove it from your expenses — taking
          a roof out of the roof total and amortizing it back into CAM changes what tenants are
          billed, so it stays a separate, deliberate step.
        </div>
      )}
      <MutationError of={[add, remove, setLand]} />
    </div>
  );
}
