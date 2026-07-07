import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listSenderEmails } from '../lib/api';
import { gmailComposeUrl, mailtoUrl, openCompose } from '../lib/email';
import RecipientField from './RecipientField';
import { useModalA11y } from './modalA11y';

// The ready-to-send tenant email a renewal/escalation notification carries. Lets
// the landlord pick the sending account + recipient and send via Gmail / mail app
// or copy it. (Moved out of the old top-bar bell so the dashboard hub can use it.)
export default function NotificationEmailModal({ notif, onClose, onSent, onSend }) {
  // Escape closes; focus is trapped in the dialog and returned on close.
  const modalRef = useModalA11y(onClose);
  const { data: senderEmails = [] } = useQuery({ queryKey: ['senderEmails'], queryFn: listSenderEmails });
  const [from, setFrom] = useState(notif.email_from || '');
  const [to, setTo] = useState(notif.email_to || '');
  const [subject, setSubject] = useState(notif.email_subject || '');
  const [body, setBody] = useState(notif.email_body || '');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!from && senderEmails.length) {
      setFrom(notif.email_from && senderEmails.includes(notif.email_from) ? notif.email_from : senderEmails[0]);
    }
  }, [senderEmails]); // eslint-disable-line react-hooks/exhaustive-deps

  function copy() {
    navigator.clipboard?.writeText(`To: ${to}\nSubject: ${subject}\n\n${body}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }

  // Open the chosen mail client, then let the caller record that it went out
  // (e.g. log an insurance request). Distinct from onSent, which dismisses the reminder.
  function send(url) {
    openCompose(url);
    onSend?.({ to, subject });
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" ref={modalRef} role="dialog" aria-modal="true" tabIndex={-1} style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>Email to tenant</strong>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          <label className="form-field" style={{ maxWidth: '100%' }}>
            <span>Send from</span>
            {senderEmails.length ? (
              <select className="text-input" value={from} onChange={(e) => setFrom(e.target.value)}>
                {senderEmails.map((em) => <option key={em} value={em}>{em}</option>)}
              </select>
            ) : (
              <input className="text-input" type="email" value={from} onChange={(e) => setFrom(e.target.value)} placeholder="your@email.com" />
            )}
            <small className="field-note">Be signed into this Google account in your browser — otherwise Gmail opens in whichever account you’re logged into.</small>
          </label>
          <RecipientField primary={notif.email_to || ''} secondary={notif.email_to_2 || ''} value={to} onChange={setTo} />
          <label className="form-field" style={{ maxWidth: '100%' }}>
            <span>Subject</span>
            <input className="text-input" value={subject} onChange={(e) => setSubject(e.target.value)} />
          </label>
          <label className="form-field" style={{ maxWidth: '100%', marginBottom: 0 }}>
            <span>Message</span>
            <textarea className="invoice-text" value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        </div>
        <div className="modal-foot">
          <div className="modal-actions" style={{ justifyContent: 'flex-end', gap: 10 }}>
            <button className="secondary" onClick={onSent}>Mark sent &amp; dismiss</button>
            <button className="secondary" onClick={copy}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
            <button className="secondary" onClick={() => send(mailtoUrl({ to, subject, body }))}>✉ Other app</button>
            <button onClick={() => send(gmailComposeUrl({ from, to, subject, body }))}>📧 Send via Gmail</button>
          </div>
        </div>
      </div>
    </div>
  );
}
