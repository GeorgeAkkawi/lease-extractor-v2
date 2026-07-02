import { useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCorporation, getProperty, createLease, createLeaseFromExtraction, buildEscalations, buildRenewals, buildAbatements, isoDateOrNull } from '../lib/api';
import { resolveCurrentTerm } from '../lib/leaseTerm';
import { abatementKindLabel } from '../lib/abatement';
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
        // Anchor any lease-year (undated) rent steps to the start date the user confirmed.
        escalations: buildEscalations(lease.base_rent, extractedDoc.extraction.escalations, lease.lease_start),
        renewals: buildRenewals(extractedDoc.extraction.renewal_options),
        abatements: buildAbatements(extractedDoc.extraction.abatements),
        aiConfidence: buildAiConfidence(extractedDoc.extraction),
        leaseText: extractedDoc.lease_text,
      }),
    onSuccess: afterCreate,
  });

  if (extractedDoc) {
    const ex = extractedDoc.extraction;
    // Many leases print no commencement date (it's a formula — "120 days after delivery
    // of possession"), so the AI reads the rent table by lease year with no real dates.
    // When that's the case, ask for the start date up front: entering it here dates the
    // whole schedule + end date automatically on save.
    const missingStart = !val(ex.lease_start);
    const hasDatedData =
      Number(ex?.term_months?.value) > 0 ||
      (Array.isArray(ex.escalations) && ex.escalations.some((e) => !isoDateOrNull(e.effective_date) && e.months_from_start != null)) ||
      (Array.isArray(ex.abatements) && ex.abatements.length > 0);
    return (
      <div>
        <div className="page-head">
          <div><h1>Review extracted lease</h1><div className="muted">AI-extracted — check values, then save.</div></div>
          <div className="head-actions"><button className="secondary" onClick={() => setExtractedDoc(null)}>Start over</button></div>
        </div>
        <div className="panel">
          {missingStart && hasDatedData && (
            <div className="callout warn" style={{ marginBottom: 16 }}>
              <div className="alert-main">
                <div className="alert-title"><strong>📅 This lease doesn’t print a start date — enter it below</strong></div>
                <div className="muted">
                  The lease sets its start by a formula (e.g. “120 days after delivery of possession”), not a fixed date,
                  so the rent schedule was read by <strong>lease year</strong>. Type the date the lease actually started into
                  <strong> Lease start</strong> and the app will fill in the end date and date every rent step for you when you save.
                  You can also save now and add the date later on the lease page.
                </div>
              </div>
            </div>
          )}
          <LeaseForm initial={initialFromExtraction(ex)} extracted={ex} onSubmit={(lease) => createFromAi.mutate(lease)} submitLabel="Save lease" busy={createFromAi.isPending} />
          <SchedulePreview ex={ex} />
          {createFromAi.isError && <p className="note-msg danger" style={{ marginTop: 10 }}>{createFromAi.error.message}</p>}
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
        {createManual.isError && <p className="note-msg danger" style={{ marginTop: 10 }}>{createManual.error.message}</p>}
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
  const escs = buildEscalations(base, ex.escalations, start).map((e) => ({ ...e, status: 'scheduled' }));
  // Lease-year steps with no printed date (they get real dates from the Lease start above,
  // at save). Only surfaced here when we couldn't date them yet (no extracted start).
  const rawEsc = Array.isArray(ex.escalations) ? ex.escalations : [];
  const relativeSteps = rawEsc
    .filter((e) => !isoDateOrNull(e.effective_date) && e.months_from_start != null && isFinite(Number(e.months_from_start)))
    .map((e) => ({ months: Number(e.months_from_start), rent: Number(e.new_base_rent) }))
    .sort((a, b) => a.months - b.months);
  const showRelative = escs.length === 0 && relativeSteps.length > 0;
  const rens = buildRenewals(ex.renewal_options).map((r, i) => ({ ...r, id: `r${i}`, status: 'pending' }));
  const abs = buildAbatements(ex.abatements);
  const res = resolveCurrentTerm({ lease: { base_rent: base, lease_start: start, lease_termination_date: end }, escalations: escs, renewals: rens });
  const advanced = Math.round(res.currentRent) !== Math.round(base);
  const flag = ex.rent_schedule_flag;

  return (
    <div className="callout" style={{ marginTop: 14 }}>
      <div className="alert-title"><strong>What gets saved — rent schedule</strong></div>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        The form above shows the lease's <strong>starting</strong> rent. On save it rolls forward to today through the step-ups below.
      </div>
      {flag && (
        <p className="note-msg warn" style={{ marginBottom: 8 }}>
          ⚠ Some steps were read from a $/SF rate — double-check these amounts against the lease before saving.
        </p>
      )}
      <ul style={{ margin: '0 0 8px', paddingLeft: 18 }}>
        <li>Start{start ? ` (${fmtDate(start)})` : ''}: <strong>{money(base)}/yr</strong></li>
        {escs.map((e, i) => (
          <li key={i}>{fmtDate(e.effective_date)}: <strong>{money(e.new_base_rent)}/yr</strong></li>
        ))}
        {showRelative && relativeSteps.map((s, i) => (
          <li key={`rel${i}`}>After {s.months} months: <strong>{money(s.rent)}/yr</strong></li>
        ))}
      </ul>
      {showRelative && (
        <p className="note-msg" style={{ marginBottom: 8, fontSize: 12.5 }}>
          These step-ups are dated by lease year — they’ll get their real dates from the <strong>Lease start</strong> you enter above when you save.
        </p>
      )}
      {escs.length === 0 && !showRelative && (
        <p className="note-msg warn" style={{ marginBottom: 8 }}>
          No dated rent step-ups were detected. If the document has a rent schedule, add the steps under “Rent escalations” after saving, or re-upload a clearer copy.
        </p>
      )}
      <div style={{ fontSize: 14 }}>
        Current base rent as of today: <strong>{money(res.currentRent)}/yr</strong>
        {advanced && <span className="badge good" style={{ marginLeft: 8 }}>rolled forward</span>}
        {res.status === 'expired' && <span className="muted"> (term appears past — it'll be flagged for an extension)</span>}
      </div>
      {rens.length > 0 && <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>+ {rens.length} renewal option(s) imported.</div>}
      {abs.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <span className="badge warn">Rent abatement</span>{' '}
          <span className="muted" style={{ fontSize: 12.5 }}>
            {abs.map((a, i) => `${fmtDate(a.start_date)}–${fmtDate(a.end_date)} (${abatementKindLabel(a)})`).join('; ')} — credited on the invoice &amp; monthly tracker.
          </span>
        </div>
      )}
    </div>
  );
}
