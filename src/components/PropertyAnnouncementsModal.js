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
import { useOptimisticRemove } from './useOptimisticRemove';
import SelectMenu from './SelectMenu';

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

  // TENANTS and ADDRESSES are deliberately two different numbers, because one landlord can
  // run several businesses out of the same building under one contact address (George,
  // 2026-08-04: "mario is the same email for 2 tenants"). Both his tenancies are notified —
  // so the count reads 4 of 4 — but he gets ONE email, not two copies of the same notice.
  const selected = useMemo(() => mailable.filter((l) => !excluded.has(l.id)), [mailable, excluded]);

  // First-seen casing wins; matching is case-insensitive. (The edge function dedupes again
  // on the same rule — this is the copy that has to agree with what the screen SAYS.)
  const addresses = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const l of selected) {
      const addr = l.tenant_email.trim();
      const key = addr.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(addr);
    }
    return out;
  }, [selected]);

  // Which addresses are shared, so the rows can say so rather than leaving him to compare
  // two email strings by eye — which is exactly how "3 of 4" read as a bug.
  const sharedAddresses = useMemo(() => {
    const counts = new Map();
    for (const l of mailable) {
      const key = l.tenant_email.trim().toLowerCase();
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return new Set([...counts].filter(([, n]) => n > 1).map(([k]) => k));
  }, [mailable]);

  const plural = (n) => (n === 1 ? '' : 's');

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

  const removeTemplate = useOptimisticRemove({
    queryKey: ['announcementTemplates'], idOf: (id) => id,
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
    mutationFn: () => sendAnnouncement({ recipients: addresses, subject, body, replyTo: from || null }),
    onSuccess: async (res) => {
      setSendError('');
      // Report in TENANTS, since that is what he ticked — a shared address that lands
      // notifies both tenancies. Count them off the addresses that actually succeeded, so
      // a partial failure can't overstate the reach.
      const landed = new Set((res?.sent || []).map((s) => String(s.to || '').toLowerCase()));
      const tenantsReached = selected.filter((l) => landed.has(l.tenant_email.trim().toLowerCase())).length;
      const emailsSent = res?.sent?.length || 0;
      setResult({ tenantsReached, emailsSent, failed: res?.failed || [] });
      if (emailsSent) {
        clearDraft();
        await logAnnouncementSent({
          propertyId: property.id,
          propertyName: property.name,
          subject,
          sentCount: tenantsReached,
          emailsSent,
          failedCount: res?.failed?.length || 0,
        });
        // ⚠ `historyEvents` is the key the History page actually reads; `history` is a
        // near-miss that repaints nothing.
        qc.invalidateQueries({ queryKey: ['historyEvents'] });
      }
    },
    onError: (e) => setSendError(e?.message || 'Couldn’t send the announcement — try Copy and send it from your own email.'),
  });

  async function confirmAndSend() {
    const names = selected.map(
      (l) => `${l.tenant_name || 'Tenant'} — ${l.tenant_email}` +
        (sharedAddresses.has(l.tenant_email.trim().toLowerCase()) ? ' (shared address)' : '')
    );
    const shared = selected.length - addresses.length;
    const ok = await askConfirm({
      title: 'Send this announcement?',
      message:
        `“${subject}” will be emailed to ${selected.length} tenant${plural(selected.length)} at ${property.name}. ` +
        (shared
          ? `That is ${addresses.length} email${plural(addresses.length)} — ${shared} tenanc${shared === 1 ? 'y shares' : 'ies share'} an address with another, and a shared address gets one copy, not two. `
          : 'Each one receives their own copy ') +
        `from ${corp?.name || 'your business'}, with replies going to ${from || 'your business email'}.`,
      implications: names,
      confirmLabel: `Send to ${selected.length} tenant${plural(selected.length)}`,
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

  const canSend = Boolean(subject.trim() && body.trim() && addresses.length);
  // How many fewer emails than tenants, and how many tenants are actually involved in the
  // sharing — Mario's two leases on one address are 1 saved email but 2 tenants, and it is
  // the 2 he needs to see explained.
  const sharedCount = selected.length - addresses.length;
  const sharingCount = selected.filter((l) => sharedAddresses.has(l.tenant_email.trim().toLowerCase())).length;

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
              <span className="muted" style={{ fontSize: 12 }}>{selected.length} of {mailable.length}</span>
            </div>
            <div className="announce-side-actions">
              <button className="ghost btn-sm" onClick={selectAll}>Select all</button>
              <button className="ghost btn-sm" onClick={selectNone}>None</button>
            </div>
            {sharedCount > 0 && (
              <p className="announce-shared-note muted">
                {addresses.length} email{plural(addresses.length)} for {selected.length} tenants — {sharingCount} of
                them share an address and get one copy between them.
              </p>
            )}

            <ul className="announce-recipients">
              {leases.length === 0 && <li className="muted">No tenants on this property yet.</li>}
              {leases.map((l) => {
                const email = (l.tenant_email || '').trim();
                // George, 2026-08-04: *"dennys doesnt have an email on file and its hard to
                // see that on the announcements, make the formatting the same as the other
                // tenants but just make the box uncheckable until an email is added."*
                //
                // It used to render as a bare name + note with NO checkbox, so it was a
                // different shape from every row around it and the eye slid straight past
                // it — which is how a tenant silently drops out of an announcement. Now it
                // is the same row, with the same checkbox, that simply cannot be ticked.
                if (!email) {
                  return (
                    <li key={l.id} className="announce-recipient missing">
                      <label title="Add an email address on this tenant’s lease to include them">
                        <input type="checkbox" checked={false} disabled readOnly />
                        <span>
                          {l.tenant_name || 'Tenant'}
                          <small>no email on file — add one to include them</small>
                        </span>
                      </label>
                    </li>
                  );
                }
                return (
                  <li key={l.id} className="announce-recipient">
                    <label>
                      <input type="checkbox" checked={!excluded.has(l.id)} onChange={() => toggle(l.id)} />
                      <span>
                        {l.tenant_name || 'Tenant'}
                        {/* Say it on the row rather than leaving him to compare two email
                            strings by eye — that comparison is what made the count look wrong. */}
                        <small className="muted">
                          {email}{sharedAddresses.has(email.toLowerCase()) ? ' · shared address' : ''}
                        </small>
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
                <SelectMenu className="text-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                  {senderEmails.map((em) => <option key={em} value={em}>{em}</option>)}
                </SelectMenu>
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
              {/* Reported in TENANTS — what he ticked — with the email count alongside only
                  when the two differ, so a shared address explains itself. */}
              <span className="badge good">
                ✓ Sent to {result.tenantsReached} tenant{plural(result.tenantsReached)}
                {result.emailsSent !== result.tenantsReached ? ` · ${result.emailsSent} email${plural(result.emailsSent)}` : ''}
              </span>
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
                  ? `Sending to ${selected.length}…`
                  : `📨 Send to ${selected.length} tenant${plural(selected.length)}`}
              </button>
            </div>
          )}
          <MutationError of={[saveTemplate, removeTemplate]} />
        </div>
      </div>
    </div>
  );
}
