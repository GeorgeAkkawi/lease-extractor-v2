import { useState } from 'react';
import { sendTenantEmail } from '../lib/api';

// One-click "Send now": delivers the letter directly from the app (via the verified
// amlakre.com domain, replies routed to the landlord's business email). Shared by the
// three email screens. Sends ONLY when clicked — never on its own. On success it
// calls onSent({ id }) so the caller can keep its existing logging (e.g. record an
// insurance request); on failure it shows an inline note pointing at the Gmail button.
export default function SendNowButton({ to, subject, body, replyTo, onSent, disabled }) {
  const [status, setStatus] = useState('idle'); // idle | sending | sent
  const [error, setError] = useState('');

  const canSend = !disabled && to && subject && body;

  async function send() {
    if (!canSend || status === 'sending') return;
    setStatus('sending');
    setError('');
    try {
      const res = await sendTenantEmail({ to, subject, body, replyTo });
      setStatus('sent');
      onSent?.(res || {});
    } catch (e) {
      setStatus('idle');
      setError(e?.message || 'Couldn’t send — try the Gmail button instead.');
    }
  }

  if (status === 'sent') {
    return <span className="badge good">✓ Sent to {to}</span>;
  }

  return (
    <>
      {error && <span className="note-msg danger" style={{ marginRight: 8 }}>{error}</span>}
      <button onClick={send} disabled={!canSend || status === 'sending'}>
        {status === 'sending' ? 'Sending…' : '📨 Send now'}
      </button>
    </>
  );
}
