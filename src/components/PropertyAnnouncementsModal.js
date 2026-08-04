import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  businessFromCorp,
  deleteAnnouncementTemplate,
  draftAnnouncement,
  listAnnouncementTemplates,
  listLeases,
  listSenderEmails,
  logAnnouncementSent,
  saveAnnouncementTemplate,
  sendAnnouncement,
  touchAnnouncementTemplate,
} from '../lib/api';
import { buildAnnouncementEmail } from '../lib/emailTemplates';
import { fromTemplate, toTemplate } from '../lib/announcementTokens';
import { useModalA11y } from './modalA11y';
import { useConfirm } from './ConfirmDialog';
import MutationError from './MutationError';

// One notice, every tenant of one property. Opened from the Announcements pill on a
// property card, next to Insurance.
//
// THE THREE THINGS THAT MAKE IT MORE THAN A COMPOSE BOX (George, 2026-08-04):
//
// ① It is deliberately GENERIC. The AI drafter is never shown a lease row, so the notice
//    cannot name a tenant, a suite or a figure — which is what makes "send to everyone"
//    safe. Every tenant is ticked by default; untick anyone who shouldn't get it.
// ② A CLOSED WINDOW DOESN'T COST THE TYPING. Everything in here autosaves to localStorage
//    keyed by property, so an accidental ✕ (or a refresh, or a browser restart) reopens
//    exactly where he left off. Cleared only on a successful send or an explicit Discard.
// ③ TEMPLATES REFRESH THEMSELVES. Saving stores {date}/{property}/{business} tokens rather
//    than a rendered letter (announcementTokens.js), so reopening one next winter stamps
//    today's date and this property's name for free. "↻ Rewrite with AI" is the other
//    half: same instruction, fresh wording, ~1–2¢.
//
// Nothing auto-sends. A notice goes out solely on the Send click, behind a confirm.

const draftKey = (propertyId) => `amlak.announcementDraft.${propertyId}`;

// A draft with nothing typed in it is NOT a draft. Merely opening the window (which seeds
// the "Send from" address) must not leave something behind that makes the next open
// announce "Draft restored" over an empty form — that would train him to ignore the notice
// on the one occasion it matters.
const hasContent = (d) =>
  Boolean(d && (d.request?.trim() || d.subject?.trim() || d.body?.trim() || d.excluded?.length));

function readDraft(propertyId) {
  try {
    const raw = localStorage.getItem(draftKey(propertyId));
    const parsed = raw ? JSON.parse(raw) : null;
    return hasContent(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export default function PropertyAnnouncementsModal({ property, corp, onClose }) {
  const modalRef = useModalA11y(onClose);
  const qc = useQueryClient();
  const askConfirm = useConfirm();
  const business = useMemo(() => businessFromCorp(corp), [corp]);

  // Reads the cache the property grid already seeded — no extra round-trip.
  const { data: leases = [] } = useQuery({
    queryKey: ['leases', property.id],
    queryFn: () => listLeases(property.id),
  });
  const { data: senderEmails = [] } = useQuery({ queryKey: ['senderEmails'], queryFn: listSenderEmails });
  const { data: templates = [] } = useQuery({ queryKey: ['announcementTemplates'], queryFn: listAnnouncementTemplates });

  // A lease with no address on file is shown but can't be selected — silently dropping it
  // would make "sent to 9 tenants" look complete when a tenant was never reachable.
  const mailable = useMemo(() => leases.filter((l) => (l.tenant_email || '').trim()), [leases]);

  const saved = useRef(readDraft(property.id)).current;
  const [restored, setRestored] = useState(Boolean(saved));
  const [from, setFrom] = useState(saved?.from || corp?.contact_email || '');
  const [request, setRequest] = useState(saved?.request || '');
  const [subject, setSubject] = useState(saved?.subject || '');
  const [body, setBody] = useState(saved?.body || '');
  // Store EXCLUSIONS, not selections: a lease added after the draft was saved should
  // default to receiving the notice, not be silently left out.
  const [excluded, setExcluded] = useState(() => new Set(saved?.excluded || []));
  const [aiRequest, setAiRequest] = useState(saved?.aiRequest || '');
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState(null);
  const [sendError, setSendError] = useState('');
  const [templateName, setTemplateName] = useState('');
  const [naming, setNaming] = useState(false);

  useEffect(() => {
    if (!from && senderEmails.length) setFrom(senderEmails[0]);
  }, [senderEmails]); // eslint-disable-line react-hooks/exhaustive-deps

  // Autosave. Cheap enough to run on every keystroke — it's one small JSON string. An
  // emptied form REMOVES the key rather than storing a blank draft (see hasContent).
  useEffect(() => {
    const payload = { from, request, subject, body, aiRequest, excluded: [...excluded] };
    try {
      if (hasContent(payload)) localStorage.setItem(draftKey(property.id), JSON.stringify(payload));
      else localStorage.removeItem(draftKey(property.id));
    } catch { /* private mode / quota — the draft just won't persist */ }
  }, [property.id, from, request, subject, body, aiRequest, excluded]);

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(draftKey(property.id)); } catch { /* ignore */ }
  }, [property.id]);

  const recipients = useMemo(
    () => mailable.filter((l) => !excluded.has(l.id)).map((l) => l.tenant_email.trim()),
    [mailable, excluded]
  );
  const uniqueRecipients = useMemo(() => [...new Set(recipients.map((e) => e.toLowerCase()))], [recipients]);

  const toggle = (id) => setExcluded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectAll = () => setExcluded(new Set());
  const selectNone = () => setExcluded(new Set(mailable.map((l) => l.id)));

  // --- AI draft ------------------------------------------------------------
  const draft = useMutation({
    mutationFn: (ask) =>
      draftAnnouncement({
        request: ask,
        property: { name: property.name, address: property.address, tenant_count: mailable.length },
        businessName: corp?.name || '',
      }),
    onSuccess: (res, ask) => {
      const letter = buildAnnouncementEmail({
        business,
        propertyName: property.name,
        subject: res?.subject,
        bodyProse: res?.body,
      });
      setSubject(letter.subject);
      setBody(letter.body);
      setAiRequest(ask);
      setRestored(false);
    },
  });

  // --- Templates -----------------------------------------------------------
  const saveTemplate = useMutation({
    mutationFn: () =>
      saveAnnouncementTemplate({
        name: templateName,
        // Tokenized, so reopening it later re-stamps today's date and the property it is
        // opened from rather than replaying the ones baked in when it was saved.
        subject: toTemplate({ text: subject, business, propertyName: property.name }),
        body: toTemplate({ text: body, business, propertyName: property.name }),
        aiRequest: aiRequest || null,
      }),
    onSuccess: () => {
      setNaming(false);
      setTemplateName('');
      qc.invalidateQueries({ queryKey: ['announcementTemplates'] });
    },
  });

  const removeTemplate = useMutation({
    mutationFn: (id) => deleteAnnouncementTemplate(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['announcementTemplates'] }),
  });

  function applyTemplate(t) {
    setSubject(fromTemplate({ text: t.subject, business, propertyName: property.name }));
    setBody(fromTemplate({ text: t.body, business, propertyName: property.name }));
    setAiRequest(t.ai_request || '');
    setRequest(t.ai_request || '');
    setRestored(false);
    setResult(null);
    touchAnnouncementTemplate(t.id).then(
      () => qc.invalidateQueries({ queryKey: ['announcementTemplates'] }),
      () => {} // a failed timestamp must never block using the template
    );
  }

  // --- Send ----------------------------------------------------------------
  const send = useMutation({
    mutationFn: () => sendAnnouncement({ recipients: uniqueRecipients, subject, body, replyTo: from || null }),
    onSuccess: async (res) => {
      setResult(res);
      setSendError('');
      const sentCount = res?.sent?.length || 0;
      if (sentCount) {
        clearDraft();
        await logAnnouncementSent({
          propertyId: property.id,
          propertyName: property.name,
          subject,
          sentCount,
          failedCount: res?.failed?.length || 0,
        });
        qc.invalidateQueries({ queryKey: ['history'] });
      }
    },
    onError: (e) => setSendError(e?.message || 'Couldn’t send the announcement — try Copy and send it from your own email.'),
  });

  async function confirmAndSend() {
    const names = mailable
      .filter((l) => !excluded.has(l.id))
      .map((l) => `${l.tenant_name || 'Tenant'} — ${l.tenant_email}`);
    const ok = await askConfirm({
      title: 'Send this announcement?',
      message: `“${subject}” will be emailed to ${uniqueRecipients.length} tenant${uniqueRecipients.length === 1 ? '' : 's'} at ${property.name}. Each one receives their own copy from ${corp?.name || 'your business'}, with replies going to ${from || 'your business email'}.`,
      implications: names,
      confirmLabel: `Send to ${uniqueRecipients.length} tenant${uniqueRecipients.length === 1 ? '' : 's'}`,
      cancelLabel: 'Not yet',
      tone: 'warn',
    });
    if (ok) send.mutate();
  }

  function copy() {
    navigator.clipboard?.writeText(`Subject: ${subject}\n\n${body}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }

  function discardDraft() {
    clearDraft();
    setRequest(''); setSubject(''); setBody(''); setAiRequest('');
    setExcluded(new Set());
    setRestored(false);
  }

  const canSend = Boolean(subject.trim() && body.trim() && uniqueRecipients.length);

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal announce-panel" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{property.name} — announcement to tenants</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body announce-grid">
          {/* ---------- left: who gets it, and the saved notices ---------- */}
          <div className="announce-side">
            <div className="announce-side-head">
              <span className="announce-label">Recipients</span>
              <span className="muted" style={{ fontSize: 12 }}>{uniqueRecipients.length} of {mailable.length}</span>
            </div>
            <div className="announce-side-actions">
              <button className="ghost btn-sm" onClick={selectAll}>Select all</button>
              <button className="ghost btn-sm" onClick={selectNone}>None</button>
            </div>

            <ul className="announce-recipients">
              {leases.length === 0 && <li className="muted">No tenants on this property yet.</li>}
              {leases.map((l) => {
                const email = (l.tenant_email || '').trim();
                if (!email) {
                  return (
                    <li key={l.id} className="announce-recipient missing">
                      <span>{l.tenant_name || 'Tenant'}</span>
                      <small className="muted">no email on file</small>
                    </li>
                  );
                }
                return (
                  <li key={l.id} className="announce-recipient">
                    <label>
                      <input type="checkbox" checked={!excluded.has(l.id)} onChange={() => toggle(l.id)} />
                      <span>
                        {l.tenant_name || 'Tenant'}
                        <small className="muted">{email}</small>
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>

            <div className="announce-side-head" style={{ marginTop: 16 }}>
              <span className="announce-label">Saved announcements</span>
            </div>
            <ul className="announce-templates">
              {templates.length === 0 && <li className="muted">None saved yet.</li>}
              {templates.map((t) => (
                <li key={t.id}>
                  <button className="ghost btn-sm" onClick={() => applyTemplate(t)} title="Load this announcement, dated today">
                    {t.name}
                  </button>
                  <button
                    className="icon-btn"
                    title="Delete this saved announcement"
                    onClick={async () => {
                      const ok = await askConfirm({
                        title: 'Delete this saved announcement?',
                        message: `“${t.name}” will be removed from your templates.`,
                        implications: ['Any announcement already sent stays in the property History.'],
                        confirmLabel: 'Delete',
                      });
                      if (ok) removeTemplate.mutate(t.id);
                    }}
                  >✕</button>
                </li>
              ))}
            </ul>
          </div>

          {/* ---------- right: write it ---------- */}
          <div className="announce-main">
            {restored && (
              <div className="note-msg announce-restored">
                Draft restored from last time.
                <button className="ghost btn-sm" onClick={discardDraft} style={{ marginLeft: 8 }}>Start over</button>
              </div>
            )}

            <label className="form-field" style={{ maxWidth: '100%' }}>
              <span>Send from</span>
              {senderEmails.length ? (
                <select className="text-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                  {senderEmails.map((em) => <option key={em} value={em}>{em}</option>)}
                </select>
              ) : (
                <input className="text-input" type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="your@email.com" />
              )}
              <small className="field-note">
                Tenants see “{corp?.name || 'your business'}” as the sender and replies come back to this address.
              </small>
            </label>

            <label className="form-field" style={{ maxWidth: '100%' }}>
              <span>What should this announcement say?</span>
              <textarea
                className="text-input"
                rows={2}
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                placeholder="e.g. the parking lot is being resurfaced the week of the 14th — use the rear entrance"
              />
              <small className="field-note">
                Written for every tenant at once, so it never mentions a specific tenant, suite or figure.
              </small>
            </label>

            <div className="announce-draft-row">
              <button onClick={() => draft.mutate(request.trim())} disabled={!request.trim() || draft.isPending}>
                {draft.isPending ? 'Drafting…' : '✨ Draft with AI'}
              </button>
              {aiRequest && !draft.isPending && (
                <button className="secondary" onClick={() => draft.mutate(aiRequest)} title="Same request, fresh wording and today's date">
                  ↻ Rewrite with AI
                </button>
              )}
            </div>
            <MutationError of={[draft]} message="Couldn’t draft that — try again in a moment." />

            <label className="form-field" style={{ maxWidth: '100%' }}>
              <span>Subject</span>
              <input className="text-input" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </label>

            <label className="form-field" style={{ maxWidth: '100%', marginBottom: 0 }}>
              <span>Message</span>
              <textarea className="invoice-text announce-body" value={body} onChange={(e) => setBody(e.target.value)} />
            </label>
          </div>
        </div>

        <div className="modal-foot">
          {result && (
            <div className="announce-result">
              <span className="badge good">✓ Sent to {result.sent?.length || 0} tenant{(result.sent?.length || 0) === 1 ? '' : 's'}</span>
              {result.failed?.length > 0 && (
                <span className="note-msg danger" style={{ marginLeft: 8 }}>
                  {result.failed.length} didn’t go through: {result.failed.map((f) => f.to).join(', ')}
                </span>
              )}
            </div>
          )}
          {sendError && <span className="note-msg danger">{sendError}</span>}

          {naming ? (
            <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <input
                className="text-input"
                style={{ width: 230 }}
                autoFocus
                placeholder="Name this announcement"
                value={templateName}
                onChange={(e) => setTemplateName(e.target.value)}
              />
              <button className="secondary" onClick={() => { setNaming(false); setTemplateName(''); }}>Cancel</button>
              <button onClick={() => saveTemplate.mutate()} disabled={!templateName.trim() || saveTemplate.isPending}>
                {saveTemplate.isPending ? 'Saving…' : 'Save template'}
              </button>
            </div>
          ) : (
            <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
              <button className="secondary" onClick={copy} disabled={!body.trim()}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
              <button className="secondary" onClick={() => setNaming(true)} disabled={!subject.trim() || !body.trim()}>
                ⭑ Save as template
              </button>
              <button onClick={confirmAndSend} disabled={!canSend || send.isPending}>
                {send.isPending
                  ? `Sending to ${uniqueRecipients.length}…`
                  : `📨 Send to ${uniqueRecipients.length} tenant${uniqueRecipients.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
          <MutationError of={[saveTemplate, removeTemplate]} />
        </div>
      </div>
    </div>
  );
}
