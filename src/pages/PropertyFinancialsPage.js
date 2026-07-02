import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import {
  getCorporation,
  getProperty,
  getPropertyTotals,
  getExpenseRecord,
  upsertExpenseRecord,
  getPropertyAR,
  getHiddenWidgets,
} from '../lib/api';
import { useChrome, usePageChrome } from '../context/ChromeContext';
import TenantShareTable from '../components/TenantShareTable';
import CamSection from '../components/CamSection';
import BuildingSizeEditor from '../components/BuildingSizeEditor';
import PropertyRentRoll from '../components/PropertyRentRoll';
import { money, psf, sf } from '../lib/format';

// whole-dollar money (no cents) for the compact roof billed/absorbed line
const money0 = (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US');

export default function PropertyFinancialsPage() {
  const { corpId, propId } = useParams();
  const { year } = useChrome();
  const qc = useQueryClient();

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: totals } = useQuery({ queryKey: ['propertyTotals', propId, year], queryFn: () => getPropertyTotals(propId, year), placeholderData: keepPreviousData });
  const { data: expense } = useQuery({ queryKey: ['expenseRecord', propId, year], queryFn: () => getExpenseRecord(propId, year), placeholderData: keepPreviousData });
  const { data: hiddenWidgets = [] } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });
  usePageChrome([
    { label: 'Financials', to: '/financials' },
    { label: corp?.name || '…', to: `/financials/${corpId}` },
    { label: prop?.name || '…' },
  ], true);

  const totalSf = totals?.total_sf ?? 0;
  const buildingSf = (totals?.building_sf ?? Number(prop?.building_sf)) || 0;
  const occupancy = totals?.occupancy != null ? Math.round(totals.occupancy * 100) : null;
  const revenue = totals?.total_revenue ?? 0;
  const taxes = Number(totals?.taxes_total ?? expense?.taxes_total ?? 0);
  const cam = Number(totals?.cam_total ?? expense?.cam_total ?? 0);
  const roof = Number(totals?.roof_total ?? expense?.roof_total ?? 0);
  const totalExp = taxes + cam + roof;
  const noi = totals?.noi ?? revenue - totalExp;
  const margin = revenue > 0 ? Math.round((noi / revenue) * 100) : null;
  const roofRecovered = totals?.roof_recovered ?? 0;
  const roofUnrecovered = totals?.roof_unrecovered ?? roof;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{prop?.name || '…'}</h1>
          <div className="muted">
            {prop?.address ? `${prop.address} · ` : ''}FY {year} · {sf(totalSf)} leased
            {buildingSf ? ` of ${Number(buildingSf).toLocaleString()}` : ''}
            {occupancy != null ? ` · ${occupancy}% occupied` : ''}
          </div>
        </div>
      </div>

      <div className="metric-group">
        <div className="fin-subhead">Performance · FY {year}</div>
        <div className="metrics">
          <StatCard label="Revenue (annualized)" main={money(revenue)} footValue={totalSf ? psf(revenue / totalSf) : '—'} footCap="per leased sq ft" />
          <StatCard label="Total expenses" main={money(totalExp)} footValue={totalSf ? psf(totalExp / totalSf) : '—'} footCap="per leased sq ft" />
          <StatCard label="Net operating income" main={money(noi)} footValue={margin != null ? `${margin}%` : '—'} footCap="operating margin" />
        </div>
      </div>

      <div className="metric-group">
        <div className="fin-subhead">Recoverable expenses · billed back to tenants</div>
        <div className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
          Big number = the year's total. Smaller number beneath = the rate per leased square foot each tenant is charged.
        </div>
        <div className="metrics">
          <StatCard label="Property taxes" main={money(taxes)} footValue={psf(totals?.tax_psf)} footCap="charged per sq ft" />
          <StatCard label="CAM / maintenance" main={money(cam)} footValue={psf(totals?.cam_psf)} footCap="charged per sq ft" />
          <StatCard
            label="Roof (billed separately)"
            main={money(roof)}
            footValue={totalSf ? psf(roof / totalSf) : '—'}
            footCap="rate per sq ft"
            note={
              <>
                <span><strong className="pos">{money0(roofRecovered)}</strong> billed</span>
                <span><strong>{money0(roofUnrecovered)}</strong> absorbed</span>
              </>
            }
          />
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <strong>Expense entry · FY {year}</strong>
          <span className="muted">Taxes & roof below; CAM is itemized. PSF recalculates instantly.</span>
        </div>
        <BuildingSizeEditor propId={propId} buildingSf={prop?.building_sf} />
        <ExpenseForm propId={propId} year={year} expense={expense} qc={qc} />
        <div className="cam-block">
          <div className="cam-head">
            <div>
              <strong>CAM / maintenance — itemized</strong>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                Every component that rolls into CAM. The total drives the CAM PSF tenants are billed.
              </div>
            </div>
          </div>
          <CamSection propId={propId} year={year} expense={expense} />
        </div>
      </div>

      <ARSummary propId={propId} />

      {!hiddenWidgets.includes('property_rent_roll') && <PropertyRentRoll propertyId={propId} year={year} />}

      <h3 className="section-title">Per-tenant breakdown</h3>
      <TenantShareTable propertyId={propId} year={year} />
    </div>
  );
}

// Receivables roll-up for the property: total outstanding + current/30/60/90+ aging.
function ARSummary({ propId }) {
  const { data: ar } = useQuery({ queryKey: ['propertyAR', propId], queryFn: () => getPropertyAR(propId) });
  if (!ar) return null;
  const b = ar.buckets || {};
  return (
    <div className="metric-group">
      <div className="fin-subhead">Receivables · outstanding</div>
      <div className="muted" style={{ fontSize: 12, marginTop: -8, marginBottom: 12 }}>
        Across all saved invoices for this property (excludes paid, void, and drafts). Aged by how far past due.
      </div>
      <div className="metrics">
        <StatCard label="Outstanding" main={money(ar.outstanding)} footValue={`${ar.count} invoice${ar.count === 1 ? '' : 's'}`} footCap="still owed" />
        <StatCard label="Current / not due" main={money(b.current || 0)} />
        <StatCard label="1–60 days late" main={money((b.d30 || 0) + (b.d60 || 0))} />
        <StatCard label="60+ days late" main={money(b.d90 || 0)} footCap={b.d90 > 0 ? 'follow up' : undefined} />
      </div>
    </div>
  );
}

function StatCard({ label, main, footValue, footCap, note }) {
  return (
    <div className="metric stat">
      <div className="label">{label}</div>
      <div className="value">{main}</div>
      {footValue != null && (
        <div className="stat-foot">
          <span className="stat-psf">{footValue}</span>
          <span className="stat-cap">{footCap}</span>
        </div>
      )}
      {note && <div className="stat-note">{note}</div>}
    </div>
  );
}

function ExpenseForm({ propId, year, expense, qc }) {
  const [taxes, setTaxes] = useState('');
  const [roof, setRoof] = useState('');
  useEffect(() => {
    setTaxes(expense?.taxes_total ?? '');
    setRoof(expense?.roof_total ?? '');
  }, [expense, year]);

  const save = useMutation({
    mutationFn: () =>
      upsertExpenseRecord({
        property_id: propId,
        year,
        taxes_total: Number(taxes) || 0,
        cam_total: expense?.cam_total ?? 0, // preserved; maintained by CAM section
        roof_total: Number(roof) || 0,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expenseRecord', propId, year] });
      qc.invalidateQueries({ queryKey: ['propertyTotals', propId, year] });
      qc.invalidateQueries({ queryKey: ['tenantShares', propId, year] });
      qc.invalidateQueries({ queryKey: ['corpRollups'] }); // expenses feed the corp roll-up
    },
  });

  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} style={{ alignItems: 'flex-end' }}>
      <label className="form-field" style={{ marginBottom: 0, maxWidth: 180 }}>
        <span>Property taxes ($)</span>
        <input className="text-input num" type="number" step="any" value={taxes} onChange={(e) => setTaxes(e.target.value)} />
      </label>
      <label className="form-field" style={{ marginBottom: 0, maxWidth: 180 }}>
        <span>Roof ($) — separate</span>
        <input className="text-input num" type="number" step="any" value={roof} onChange={(e) => setRoof(e.target.value)} />
      </label>
      <button type="submit" disabled={save.isPending}>{save.isPending ? 'Saving…' : 'Save taxes & roof'}</button>
      {save.isSuccess && <span className="badge good">Saved</span>}
    </form>
  );
}
