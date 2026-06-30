import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '../lib/supabaseClient';
import { listSenderEmails, createInvoice } from '../lib/api';
import { gmailComposeUrl, mailtoUrl, openCompose } from '../lib/email';
import { buildInvoice } from '../lib/invoiceTemplate';
import { money } from '../lib/format';
import RecipientField from './RecipientField';

// Builds a tenant invoice: the draft-invoice Edge Function returns the figures
// (computed server-side from the views), and the shared template renders one
// combined amount due with an itemized monthly/annual/PSF breakdown. Pick the
// recipient and sending account, then Send via Gmail / another mail app, or Download.
export default function InvoiceButton({ share }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [facts, setFacts] = useState(null);
  const [to, setTo] = useState(share.tenant_email || '');
  const [from, setFrom] = useState('');
  const [err, setErr] = useState('');
  const { data: senderEmails = [] } = useQuery({ queryKey: ['senderEmails'], queryFn: listSenderEmails });

  const subject = `Invoice — ${share.tenant_name} (${share.year})`;

  // Persist this invoice into receivables so it shows up in AR (status 'sent').
  const total = facts ? (Number(facts.base_rent_annual || 0) + Number(facts.cam_annual || 0) + Number(facts.tax_annual || 0) + Number(facts.roof_annual || 0)) : 0;
  const saveAR = useMutation({
    mutationFn: () =>
      createInvoice({
        lease_id: share.lease_id,
        property_id: share.property_id,
        year: share.year,
        issue_date: facts?.today || null,
        due_date: facts?.due || null,
        status: 'sent',
        base_rent_annual: Number(facts?.base_rent_annual || 0),
        cam_annual: Number(facts?.cam_annual || 0),
        tax_annual: Number(facts?.tax_annual || 0),
        roof_annual: Number(facts?.roof_annual || 0),
        total_amount: total,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['invoices', share.lease_id] });
      qc.invalidateQueries({ queryKey: ['invoicesForProperty', share.property_id] });
      qc.invalidateQueries({ queryKey: ['propertyAR', share.property_id] });
      qc.invalidateQueries({ queryKey: ['portfolioAR'] });
    },
  });

  // Default sender to this corporation's address, else the first account.
  useEffect(() => {
    if (!from && senderEmails.length) setFrom(senderEmails[0]);
  }, [senderEmails]); // eslint-disable-line react-hooks/exhaustive-deps

  async function draft() {
    setOpen(true);
    setBusy(true);
    setErr('');
    setTo(share.tenant_email || '');
    saveAR.reset();
    try {
      const { facts: f0, from: f } = await invokeFunction('draft-invoice', { lease_id: share.lease_id, year: share.year });
      setFacts(f0);
      setText(buildInvoice(f0));
      if (f) setFrom(f);
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Invoice_${(share.tenant_name || 'tenant').replace(/\W+/g, '_')}_${share.year}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <button className="ghost" onClick={draft}>Invoice</button>
      {open && (
        <div className="modal-scrim" onClick={() => setOpen(false)}>
          <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <strong>Invoice — {share.tenant_name} ({share.year})</strong>
              <button className="icon-btn" onClick={() => setOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              {busy && <div className="ai-loading"><span className="spinner" /> Preparing invoice…</div>}
              {err && <div className="ai-error">{err}</div>}
              {!busy && !err && (
                <>
                  <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                    <label className="form-field" style={{ flex: 1, marginBottom: 12 }}>
                      <span>Send from</span>
                      {senderEmails.length ? (
                        <select className="text-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                          {senderEmails.map((em) => <option key={em} value={em}>{em}</option>)}
                        </select>
                      ) : (
                        <input className="text-input" type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="your@email.com" />
                      )}
                      <small className="field-note">Be signed into this Google account for Gmail to open there.</small>
                    </label>
                    <RecipientField primary={share.tenant_email} secondary={share.tenant_email_2} value={to} onChange={setTo} style={{ flex: 1, marginBottom: 12 }} />
                  </div>
                  <textarea className="invoice-text" wrap="off" value={text} onChange={(e) => setText(e.target.value)} />
                </>
              )}
            </div>
            <div className="modal-foot">
              <div className="modal-actions" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                <div>
                  {saveAR.isSuccess ? (
                    <span className="badge good">✓ Saved to receivables ({money(total)})</span>
                  ) : (
                    <button className="secondary" onClick={() => saveAR.mutate()} disabled={busy || !facts || saveAR.isPending}>
                      {saveAR.isPending ? 'Saving…' : `＋ Save to receivables (${money(total)})`}
                    </button>
                  )}
                  {saveAR.isError && <span className="badge danger" style={{ marginLeft: 8 }}>{saveAR.error.message}</span>}
                </div>
                <div className="row" style={{ gap: 8 }}>
                  <button className="secondary" onClick={download} disabled={busy || !text}>⬇ Download</button>
                  <button className="secondary" onClick={() => openCompose(mailtoUrl({ to, subject, body: text }))} disabled={busy || !text}>✉ Other app</button>
                  <button onClick={() => openCompose(gmailComposeUrl({ from, to, subject, body: text }))} disabled={busy || !text}>📧 Send via Gmail</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
