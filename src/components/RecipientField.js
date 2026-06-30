// Recipient ("To") field shared by every tenant-email send path (invoice, the
// bell's renewal/escalation email, and the generic "Email tenant" box). When a
// lease has a SECOND email on file it shows a Primary / Second / Both quick-pick
// above the address box (defaulting to the primary); with only one email it's
// just the plain editable field it always was. "Both" comma-joins the two —
// Gmail and mailto both accept a comma-separated To, so nothing else changes.
export default function RecipientField({ primary, secondary, value, onChange, label = 'To', style }) {
  const p = (primary || '').trim();
  const s = (secondary || '').trim();
  const both = [p, s].filter(Boolean).join(', ');
  const cur = (value || '').trim();

  return (
    <label className="form-field" style={{ maxWidth: '100%', ...style }}>
      <span>{label}</span>
      {s && (
        <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <Chip active={cur === p} onClick={() => onChange(p)}>Primary</Chip>
          <Chip active={cur === s} onClick={() => onChange(s)}>Second</Chip>
          <Chip active={cur === both} onClick={() => onChange(both)}>Both</Chip>
        </div>
      )}
      <input
        className="text-input"
        type="email"
        multiple={!!s}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="tenant@email.com"
      />
      {s && cur === both && <small className="field-note">Sends to both addresses.</small>}
    </label>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={active ? '' : 'secondary'}
      style={{ padding: '5px 12px', fontSize: 10, borderRadius: 999, letterSpacing: '.08em' }}
    >
      {children}
    </button>
  );
}
