import { useState, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { listSenderEmails } from '../lib/api';
import { gmailComposeUrl, mailtoUrl, openCompose } from '../lib/email';

// Reusable compose-and-send modal: pick the sending account, confirm the
// recipient, edit subject/body, then Send via Gmail / another mail app. Same send
// flow as the bell's tenant emails and invoices (client-side compose, no backend).
export default function EmailComposeModal({ title = 'Email tenant', from: initialFrom = '', to: initialTo = '', subject: initialSubject = '', body: initialBody = '', onClose }) {
  const { data: senderEmails = [] } = useQuery({ queryKey: ['senderEmails'], queryFn: listSenderEmails });
  const [from, setFrom] = useState(initialFrom);
  const [to, setTo] = useState(initialTo);
  const [subject, setSubject] = useState(initialSubject);
  const [body, setBody] = useState(initialBody);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!from && senderEmails.length) {
      setFrom(initialFrom && senderEmails.includes(initialFrom) ? initialFrom : senderEmails[0]);
    }
  }, [senderEmails]); // eslint-disable-line react-hooks/exhaustive-deps

  function copy() {
    navigator.clipboard?.writeText(`To: ${to}\nSubject: ${subject}\n\n${body}`)
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); });
  }

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" style={{ width: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <strong>{title}</strong>
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
          <label className="form-field" style={{ maxWidth: '100%' }}>
            <span>To</span>
            <input className="text-input" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder="tenant@email.com" />
          </label>
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
            <button className="secondary" onClick={copy}>{copied ? '✓ Copied' : '⧉ Copy'}</button>
            <button className="secondary" onClick={() => openCompose(mailtoUrl({ to, subject, body }))}>✉ Other app</button>
            <button onClick={() => openCompose(gmailComposeUrl({ from, to, subject, body }))}>📧 Send via Gmail</button>
          </div>
        </div>
      </div>
    </div>
  );
}
