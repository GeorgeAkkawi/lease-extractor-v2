import { useRef, useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getCorporation, getProperty, getLease, updateLease, listRenewals, listAddendums, listEscalations, getHiddenWidgets } from '../lib/api';
import { buildLeaseAskContext } from '../lib/leaseContext';
import { usePageChrome } from '../context/ChromeContext';
import EditField from '../components/EditField';
import EscalationScheduleEditor from '../components/EscalationScheduleEditor';
import RenewalOptionsEditor from '../components/RenewalOptionsEditor';
import AddendumEditor from '../components/AddendumEditor';
import InvoicesPanel from '../components/InvoicesPanel';
import MonthlyRentTracker from '../components/MonthlyRentTracker';
import RemoveTenantModal from '../components/RemoveTenantModal';
import LeaseAssistant from '../components/LeaseAssistant';
import InsuranceVault from '../components/InsuranceVault';
import EmailComposeModal from '../components/EmailComposeModal';
import { buildInsuranceRequestEmail } from '../lib/emailTemplates';
import { currentPhase } from '../lib/leaseTerm';
import { PageSkeleton } from '../components/Skeleton';
import { sf, pct, psf, money, fmtDate } from '../lib/format';

export default function LeaseDetailPage() {
  const { corpId, propId, leaseId } = useParams();
  const [searchParams] = useSearchParams();
  const focus = searchParams.get('focus'); // 'termination' | 'renewal' | 'escalation' | 'insurance' (from an alert)
  const insReq = searchParams.get('insreq'); // '1' = open the COI-request email (from the expiry alert link)
  const qc = useQueryClient();
  const navigate = useNavigate();

  // Refs to the sections an alert can point at, so we can scroll + flash them.
  const termsRef = useRef(null);
  const escRef = useRef(null);
  const renRef = useRef(null);
  const insRef = useRef(null);
  const insReqOpened = useRef(false);
  const [flash, setFlash] = useState(null);
  const [showRemove, setShowRemove] = useState(false);
  const [showInsReq, setShowInsReq] = useState(false);

  const { data: corp } = useQuery({ queryKey: ['corporation', corpId], queryFn: () => getCorporation(corpId) });
  const { data: prop } = useQuery({ queryKey: ['property', propId], queryFn: () => getProperty(propId) });
  const { data: lease, isLoading } = useQuery({ queryKey: ['lease', leaseId], queryFn: () => getLease(leaseId) });
  const { data: renewals = [] } = useQuery({ queryKey: ['renewals', leaseId], queryFn: () => listRenewals(leaseId) });
  const { data: addendums = [] } = useQuery({ queryKey: ['addendums', leaseId], queryFn: () => listAddendums(leaseId) });
  const { data: escalations = [] } = useQuery({ queryKey: ['escalations', leaseId], queryFn: () => listEscalations(leaseId) });
  // Per-account Display settings — which lease/property panels the landlord hid.
  const { data: hiddenWidgets = [] } = useQuery({ queryKey: ['dashboardPrefs'], queryFn: getHiddenWidgets });
  const showPanel = (k) => !hiddenWidgets.includes(k);
  // Show the shared fiscal-year selector only when the monthly rent tracker (which
  // follows it) is visible — hiding the tracker removes the year picker's only use here.
  usePageChrome([
    { label: 'Leases', to: '/leases' },
    { label: corp?.name || '…', to: `/leases/${corpId}` },
    { label: prop?.name || '…', to: `/leases/${corpId}/${propId}` },
    { label: lease?.tenant_name || '…' },
  ], !hiddenWidgets.includes('lease_monthly_rent'));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['lease', leaseId] });
    qc.invalidateQueries({ queryKey: ['leases', propId] });
    qc.invalidateQueries({ queryKey: ['propertyTotals'] });
    qc.invalidateQueries({ queryKey: ['tenantShares'] });
    qc.invalidateQueries({ queryKey: ['corpRollups'] }); // rent changes affect the corp revenue roll-up
  };

  // Save one field; clear its AI review flag (set conf to 1) when present.
  const saveField = useMutation({
    mutationFn: ({ field, value }) => {
      const conf = lease.ai_confidence ? { ...lease.ai_confidence, [field]: 1 } : lease.ai_confidence;
      return updateLease(leaseId, { [field]: value, ai_confidence: conf, extraction_status: 'reviewed' });
    },
    onSuccess: invalidate,
  });
  const setRoof = useMutation({
    mutationFn: (v) => updateLease(leaseId, { roof_responsible: v }),
    onSuccess: invalidate,
  });
  // Manually confirm a lease has no renewal option (e.g. AI found none). This
  // makes the lease-ending reminder say "no renewal on file".
  const setNoRenewal = useMutation({
    mutationFn: (v) => updateLease(leaseId, { no_renewal_option: v }),
    onSuccess: () => { invalidate(); qc.invalidateQueries({ queryKey: ['alerts'] }); },
  });

  // When opened from an alert, scroll the relevant section into view and flash it.
  const refByFocus = { termination: termsRef, escalation: escRef, renewal: renRef, insurance: insRef };
  useEffect(() => {
    if (!focus || isLoading || !lease) return;
    const el = refByFocus[focus]?.current;
    if (!el) return;
    setFlash(focus);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const t = setTimeout(() => setFlash(null), 2600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, isLoading, lease?.id]);

  // Arriving from the "Request updated COI" alert link auto-opens the request email
  // (once the corp + lease data is loaded so the letter fills in).
  useEffect(() => {
    if (insReq && corp && lease && !insReqOpened.current) {
      insReqOpened.current = true;
      setShowInsReq(true);
    }
  }, [insReq, corp, lease]);

  if (isLoading || !lease) return <PageSkeleton />;

  const conf = (f) => lease.ai_confidence?.[f];
  const commit = (field) => (raw) => {
    let value = raw;
    if (field === 'square_footage' || field === 'base_rent') value = raw == null ? null : Number(raw);
    if (field === 'share_override_pct') value = raw == null || raw === '' ? null : Number(raw) / 100;
    saveField.mutate({ field, value });
  };
  const brPsf = lease.square_footage > 0 && lease.base_rent ? psf(lease.base_rent / lease.square_footage) : null;
  // Where the lease stands TODAY — drives the "Currently in" header (label, the current
  // rent period's window, the rent in effect, and the next scheduled step).
  const phase = currentPhase({ lease, escalations, renewals, addendums });
  const phasePsf = lease.square_footage > 0 && phase.rent ? psf(phase.rent / lease.square_footage) : null;
  // Rent projected to the term end — what a +%/yr renewal option steps up from.
  const rentAtTermEnd = (() => {
    const end = lease.lease_termination_date;
    const steps = (escalations || []).filter((e) => e.effective_date && (!end || e.effective_date <= end))
      .sort((a, b) => String(b.effective_date).localeCompare(String(a.effective_date)));
    return steps.length ? Number(steps[0].new_base_rent) || 0 : Number(lease.base_rent) || 0;
  })();
  // A still-active lease whose term has already passed = month-to-month holdover.
  // We never auto-change its state; we prompt the landlord to decide (renew / keep
  // as holdover / remove). Local-date compare avoids a UTC off-by-one.
  const pad = (n) => String(n).padStart(2, '0');
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const pastTerm = lease.is_active !== false && lease.lease_termination_date && lease.lease_termination_date < todayIso;

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>{lease.tenant_name}</h1>
          <div className="muted">{prop?.name} · {corp?.name}</div>
          <span className="badge info" style={{ marginTop: 10, display: 'inline-block' }}>{sf(lease.square_footage)}{lease.share_override_pct != null ? ` · ${pct(lease.share_override_pct)} share` : ''}</span>
        </div>
        <div className="head-actions">
          <button className="secondary" onClick={() => setShowRemove(true)}>Remove tenant</button>
        </div>
      </div>

      {focus && (
        <div className="callout" style={{ marginBottom: 16, borderLeftColor: 'var(--accent)' }}>
          <div className="alert-main">
            <div className="alert-title"><strong>
              {focus === 'termination' && 'Why you’re here: a Lease ending alert'}
              {focus === 'renewal' && 'Why you’re here: a Renewal notice alert'}
              {focus === 'escalation' && 'Why you’re here: a Rent escalation alert'}
              {focus === 'insurance' && 'Why you’re here: a Tenant insurance expiring alert'}
            </strong></div>
            <div className="muted">
              {focus === 'termination' && `This lease’s term ends ${fmtDate(lease.lease_termination_date)}. If it’s being renewed, update the “Lease termination” date in Lease terms below.`}
              {focus === 'renewal' && 'A renewal-option notice deadline is approaching. The notice-by date is the cut-off for giving the tenant (or receiving) written notice about renewing — see Renewal options below.'}
              {focus === 'escalation' && 'A scheduled rent increase is coming up. It applies automatically on its effective date and updates the base rent — no action needed; this is just your heads-up.'}
              {focus === 'insurance' && 'This tenant’s certificate of insurance is expiring soon. Use “Request from tenant” in the Insurance panel below to ask for an updated copy.'}
            </div>
          </div>
        </div>
      )}

      {lease.extraction_status === 'pending' && (
        <div className="callout warn" style={{ marginBottom: 16 }}>
          <div className="alert-main">
            <div className="alert-title"><strong>AI-extracted — review before confirming</strong></div>
            <div className="muted">Click any flagged field to fix it; editing clears the review badge.</div>
          </div>
        </div>
      )}

      <div className={`panel${flash === 'termination' ? ' panel-flash' : ''}`} ref={termsRef}>
        <div className="panel-head">
          <strong>Lease terms</strong>
          <span className="muted">Click any field to edit — fixes AI mistakes</span>
        </div>

        {lease.is_active === false ? (
          <div className="callout warn" style={{ margin: '0 0 16px' }}>
            <div className="alert-main">
              <div className="alert-title"><strong>This lease is outdated — no information was added</strong></div>
              <div className="muted">
                The term ended {fmtDate(lease.lease_termination_date)} with no active option reaching today. Add an
                effective lease or an extension/addendum in <strong>Addendums &amp; riders</strong> below to bring it
                current — the rent and financials will update automatically.
              </div>
            </div>
          </div>
        ) : pastTerm ? (
          <div className="callout warn" style={{ margin: '0 0 16px' }}>
            <div className="alert-main">
              <div className="alert-title"><strong>Term ended {fmtDate(lease.lease_termination_date)} — still on the books</strong></div>
              <div className="muted">
                Past its term and currently treated as a <strong>month-to-month holdover</strong> at {money(phase.rent)}{phasePsf ? ` (${phasePsf})` : ''}. Your call:
                {' '}<strong>renew it</strong> (add a renewal option below), <strong>keep it as holdover</strong> (no action — it keeps billing),
                or use <strong>Remove tenant</strong> above to mark it vacated or terminated. Nothing changes automatically.
              </div>
            </div>
          </div>
        ) : (
          <div className="callout" style={{ margin: '0 0 16px', borderLeftColor: 'var(--accent)' }}>
            <div className="alert-main">
              <div className="alert-title"><strong>Currently in: {phase.label}</strong></div>
              <div className="muted">
                {fmtDate(phase.phaseStart)} – {fmtDate(phase.termEnd)} · rent {money(phase.rent)}{phasePsf ? ` (${phasePsf})` : ''}
                {phase.nextStep ? ` · next step ${money(phase.nextStep.rent)} on ${fmtDate(phase.nextStep.date)}` : ''}
              </div>
            </div>
          </div>
        )}

        <div className="field-grid">
          <EditField label="Tenant name" value={lease.tenant_name} onCommit={commit('tenant_name')} />
          <EditField label="Tenant contact" value={lease.tenant_contact_name || ''} onCommit={commit('tenant_contact_name')} hint="person to address" />
          <EditField label="Tenant email" value={lease.tenant_email || ''} onCommit={commit('tenant_email')} hint="where emails are sent" />
          <EditField label="Second email" value={lease.tenant_email_2 || ''} onCommit={commit('tenant_email_2')} hint="optional — offered when sending" />
          <EditField label="Square footage" type="number" value={lease.square_footage} onCommit={commit('square_footage')} conf={conf('square_footage')} hint="SF" />
          <EditField label="Base rent (annual)" type="number" prefix="$" value={lease.base_rent} onCommit={commit('base_rent')} conf={conf('base_rent')} hint={brPsf ? `${brPsf} base rent` : undefined} />
          <EditField label="Lease start" type="date" value={lease.lease_start || ''} onCommit={commit('lease_start')} conf={conf('lease_start')} />
          <EditField label="Lease termination" type="date" value={lease.lease_termination_date || ''} onCommit={commit('lease_termination_date')} conf={conf('lease_termination_date')} />
          <EditField label="Tax/CAM share override (%)" type="number" value={lease.share_override_pct != null ? Math.round(lease.share_override_pct * 1000) / 10 : ''} onCommit={commit('share_override_pct')} hint="blank = pro-rata by SF" />
          <EditField label="Lease terms / notes" value={lease.lease_terms || ''} onCommit={commit('lease_terms')} conf={conf('lease_terms')} />
        </div>

        <div className="field" style={{ marginTop: 20 }}>
          <span className="field-label">Charge roof PSF</span>
          <div className="seg">
            <button className={`seg-btn${lease.roof_responsible ? ' on' : ''}`} onClick={() => setRoof.mutate(true)} disabled={setRoof.isPending}>On</button>
            <button className={`seg-btn${!lease.roof_responsible ? ' on' : ''}`} onClick={() => setRoof.mutate(false)} disabled={setRoof.isPending}>Off</button>
          </div>
          <span className="field-hint muted">
            {lease.roof_responsible
              ? 'Billed its pro-rata share of the roof expense (by SF).'
              : 'Exempt — the landlord absorbs this tenant’s share of the roof expense.'}
          </span>
        </div>
      </div>

      <div className={`panel${flash === 'escalation' ? ' panel-flash' : ''}`} ref={escRef}>
        <div className="panel-head">
          <strong>Rent escalations</strong>
          <span className="muted">Applied automatically on the effective date — you’re reminded as it approaches</span>
        </div>
        <EscalationScheduleEditor lease={lease} />
      </div>

      <div className={`panel${flash === 'renewal' ? ' panel-flash' : ''}`} ref={renRef}>
        <div className="panel-head">
          <strong>Renewal options</strong>
          <span className="muted">Notice-by = deadline to act on a renewal</span>
        </div>
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5 }}>
          A renewal option is the tenant's <strong>right</strong> to extend — it never changes your term until you confirm
          the tenant is exercising it.
        </p>
        <RenewalOptionsEditor leaseId={leaseId} lease={lease} estimateBase={rentAtTermEnd} />

        <div className="no-ren">
          {lease.no_renewal_option ? (
            <>
              <span className="badge danger">No renewal option</span>
              <span className="muted" style={{ fontSize: 12.5 }}>Confirmed — this lease has no renewal. You’ll be reminded as the end date nears.</span>
              <button type="button" className="ghost" onClick={() => setNoRenewal.mutate(false)} disabled={setNoRenewal.isPending}>Undo</button>
            </>
          ) : (
            <>
              <span className="muted" style={{ fontSize: 12.5 }}>No renewal in the lease (or AI didn’t find one)? Mark it so the lease-ending reminder is clear.</span>
              <button type="button" className="secondary" onClick={() => setNoRenewal.mutate(true)} disabled={setNoRenewal.isPending}>Mark: no renewal option</button>
            </>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <strong>Addendums &amp; riders</strong>
          <span className="muted">Amendments that extend the term or change the rent/options</span>
        </div>
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5 }}>
          Add each amendment on top of the original lease — the app works out the rent and term you're in <strong>today</strong>.
        </p>
        <AddendumEditor leaseId={leaseId} leaseInactive={lease.is_active === false} squareFootage={lease.square_footage} />
      </div>

      {showPanel('lease_monthly_rent') && (
        <div className="panel">
          <div className="panel-head">
            <strong>Monthly rent</strong>
            <span className="muted">Check off each month as it's paid — follows the fiscal-year selector</span>
          </div>
          <MonthlyRentTracker lease={lease} />
        </div>
      )}

      {showPanel('lease_receivables') && (
        <div className="panel">
          <div className="panel-head">
            <strong>Receivables</strong>
            <span className="muted">Invoices &amp; payments for this tenant</span>
          </div>
          <InvoicesPanel leaseId={leaseId} />
        </div>
      )}

      <div className="panel">
        <div className="panel-head">
          <strong>Lease document &amp; assistant</strong>
          <span className="muted">Open the lease and ask questions</span>
        </div>
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5 }}>
          Ask about the original terms or where the lease stands <strong>now</strong> — it reads the lease, every rider, and your current phase.
        </p>
        <LeaseAssistant
          leaseId={lease.id}
          leaseText={lease.lease_text}
          askContext={buildLeaseAskContext({ lease, renewals, addendums, escalations })}
          canSave
        />
      </div>

      <div className={`panel${flash === 'insurance' ? ' panel-flash' : ''}`} ref={insRef}>
        <div className="panel-head">
          <strong>Insurance</strong>
          <div className="row" style={{ gap: 10 }}>
            <button type="button" className="ghost" onClick={() => setShowInsReq(true)}>Request from tenant</button>
          </div>
        </div>
        <p className="muted" style={{ marginTop: -6, marginBottom: 14, fontSize: 12.5 }}>
          The tenant's certificate of insurance. No copy on file? Use <strong>Request from tenant</strong> to email for it.
        </p>
        <InsuranceVault party="tenant" propertyId={lease.property_id} leaseId={lease.id} />
      </div>

      {showInsReq && (() => {
        const email = buildInsuranceRequestEmail({
          business: corp ? { company_name: corp.name, address: corp.address, contact_email: corp.contact_email, contact_phone: corp.contact_phone } : null,
          tenant_name: lease.tenant_name,
          contact_name: lease.tenant_contact_name,
          tenant_email: lease.tenant_email,
          propertyName: prop?.name,
        });
        return (
          <EmailComposeModal
            title="Request insurance from tenant"
            from={corp?.contact_email || ''}
            to={lease.tenant_email || ''}
            secondaryTo={lease.tenant_email_2 || ''}
            subject={email.subject}
            body={email.body}
            onClose={() => setShowInsReq(false)}
          />
        );
      })()}

      {showRemove && (
        <RemoveTenantModal
          lease={lease}
          onClose={() => setShowRemove(false)}
          onDone={() => {
            setShowRemove(false);
            invalidate();
            qc.invalidateQueries({ queryKey: ['expiredLeases'] });
            qc.invalidateQueries({ queryKey: ['alerts'] });
            qc.invalidateQueries({ queryKey: ['snapshots'] });
            qc.invalidateQueries({ queryKey: ['corpCounts'] }); // tenant count dropped
            navigate(`/leases/${corpId}/${propId}`);
          }}
        />
      )}
    </div>
  );
}
