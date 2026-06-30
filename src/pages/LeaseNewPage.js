import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCorporation, getProperty, createLease, createLeaseFromExtraction, buildEscalations, buildRenewals } from '../lib/api';
import { resolveCurrentTerm } from '../lib/leaseTerm';
import { money, fmtDate } from '../lib/format';
import { usePageChrome } from '../context/ChromeContext';
import LeaseForm from '../components/LeaseForm';
import LeaseUpload from '../components/LeaseUpload';

export default function LeaseNewPage() {
  const { corpId, propId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  usePageChrome([
    { label: 'Leases', to: '/leases' },
    { label: corp?.name || '…', to: `/leases/${corpId}` },
    { label: prop?.name || '…', to: `/leases/${corpId}/${propId}` },
    { label: 'New lease' },
  ]);

  const [extractedDoc, setExtractedDoc] = useState(null);

  const afterCreate = (row) => {
    qc.invalidateQueries({ queryKey: ['leases', propId] });
    qc.invalidateQueries({ queryKey: ['propertyTotals'] });
    qc.invalidateQueries({ queryKey: ['tenantShares'] });
    qc.invalidateQueries({ queryKey: ['corpCounts'] });   // tenant count grew
    qc.invalidateQueries({ queryKey: ['corpRollups'] });  // new rent → corp revenue
    navigate(`/leases/${corpId}/${propId}/${row.id}`);
  };

  const createManual = useMutation({
    mutationFn: (lease) => createLease({ ...lease, property_id: propId, source: 'manual' }),
    onSuccess: afterCreate,
  });
  const createFromAi = useMutation({
    mutationFn: (lease) =>
      createLeaseFromExtraction({
        propertyId: propId,
        leaseFileId: extractedDoc.lease_file_id,
        lease,
        escalations: buildEscalations(lease.base_rent, extractedDoc.extraction.escalations),
        renewals: buildRenewals(extractedDoc.extraction.renewal_options),
        aiConfidence: buildAiConfidence(extractedDoc.extraction),
        leaseText: extractedDoc.lease_text,
      }),
    onSuccess: afterCreate,
  });

  if (extractedDoc) {
    const ex = extractedDoc.extraction;
    return (
      <div>
        <div className="page-head">
          <div><h1>Review extracted lease</h1><div className="muted">AI-extracted — check values, then save.</div></div>
          <div className="head-actions"><button className="secondary" onClick={() => setExtractedDoc(null)}>Start over</button></div>
        </div>
        <div className="panel">
          <LeaseForm initial={initialFromExtraction(ex)} extracted={ex} onSubmit={(lease) => createFromAi.mutate(lease)} submitLabel="Save lease" busy={createFromAi.isPending} />
          <SchedulePreview ex={ex} />
          {createFromAi.isError && <p className="badge danger">{createFromAi.error.message}</p>}
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-head">
        <div><h1>New lease</h1><div className="muted">Upload a lease for AI extraction, or enter it manually.</div></div>
        <div className="head-actions"><Link to={`/leases/${corpId}/${propId}`}><button className="secondary">Cancel</button></Link></div>
      </div>
      <LeaseUpload onExtracted={setExtractedDoc} />
      <h3 className="section-title">…or enter manually</h3>
      <div className="panel">
        <LeaseForm onSubmit={(lease) => createManual.mutate(lease)} submitLabel="Create lease" busy={createManual.isPending} />
        {createManual.isError && <p className="badge danger">{createManual.error.message}</p>}
      </div>
    </div>
  );
}

const val = (f) => (f && f.value != null ? f.value : '');
function initialFromExtraction(ex) {
  return {
    tenant_name: val(ex.tenant_name),
    tenant_contact_name: val(ex.tenant_contact_name),
    tenant_email: val(ex.tenant_email),
    tenant_email_2: val(ex.tenant_email_2),
    square_footage: val(ex.square_footage),
    base_rent: val(ex.base_rent),
    lease_start: val(ex.lease_start),
    lease_termination_date: val(ex.lease_termination_date),
    lease_terms: val(ex.lease_terms),
    share_override_pct: '',
  };
}
function buildAiConfidence(ex) {
  const map = {};
  ['tenant_name', 'tenant_contact_name', 'tenant_email', 'tenant_email_2', 'square_footage', 'base_rent', 'lease_start', 'lease_termination_date', 'lease_terms'].forEach((f) => {
    if (ex[f] && ex[f].confidence != null) map[f] = ex[f].confidence;
  });
  return Object.keys(map).length ? map : null;
}

// Shows what will actually be saved: the dated rent schedule + the rent in effect
// TODAY (computed by the same back-fill resolver). Makes the step-ups visible on the
// review screen so the "starting rent" in the form isn't mistaken for today's rent —
// and surfaces when the document's schedule wasn't captured as dated steps.
function SchedulePreview({ ex }) {
  const base = Number(val(ex.base_rent)) || 0;
  const start = val(ex.lease_start) || null;
  const end = val(ex.lease_termination_date) || null;
  const escs = buildEscalations(base, ex.escalations).map((e) => ({ ...e, status: 'scheduled' }));
  const rens = buildRenewals(ex.renewal_options).map((r, i) => ({ ...r, id: `r${i}`, status: 'pending' }));
  const res = resolveCurrentTerm({ lease: { base_rent: base, lease_start: start, lease_termination_date: end }, escalations: escs, renewals: rens });
  const advanced = Math.round(res.currentRent) !== Math.round(base);

  return (
    <div className="callout" style={{ marginTop: 14 }}>
      <div className="alert-title"><strong>What gets saved — rent schedule</strong></div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        The form above shows the lease's <strong>starting</strong> rent. On save it rolls forward to today through the step-ups below.
      </div>
      <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
        <li>Start{start ? ` (${fmtDate(start)})` : ''}: <strong>{money(base)}/yr</strong></li>
        {escs.map((e, i) => (
          <li key={i}>{fmtDate(e.effective_date)}: <strong>{money(e.new_base_rent)}/yr</strong></li>
        ))}
      </ul>
      {escs.length === 0 && (
        <p className="badge warn" style={{ marginBottom: 8 }}>
          No dated rent step-ups were detected. If the document has a rent schedule, add the steps under “Rent escalations” after saving, or re-upload a clearer copy.
        </p>
      )}
      <div style={{ fontSize: 14 }}>
        Current base rent as of today: <strong>{money(res.currentRent)}/yr</strong>
        {advanced && <span className="badge good" style={{ marginLeft: 8 }}>rolled forward</span>}
        {res.status === 'expired' && <span className="muted"> (term appears past — it'll be flagged for an extension)</span>}
      </div>
      {rens.length > 0 && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>+ {rens.length} renewal option(s) imported.</div>}
    </div>
  );
}
