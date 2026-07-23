import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { getNotifyLeadTimes, setNotifyLeadTimes } from '../lib/api';
import { NOTIFY_TYPES, parseLeadTime, formatLeadDays, leadDaysFor } from '../lib/notifyPrefs';
import { usePageChrome } from '../context/ChromeContext';
import { useAuth } from '../context/AuthContext';
import { DEMO_MODE } from '../lib/supabaseClient';
import UndoStrip from '../components/UndoStrip';

// Settings › Notifications — how far ahead each kind of reminder fires. The landlord
// types a freeform value ("3 months" / "90 days" / "1 year"); the app interprets it and
// shows the reading back, so there's no doubt it understood. Saving updates both the
// dashboard alerts (instantly) and the reminder emails (the RPC rebuilds them). Every
// lead defaults to today's behavior, so a fresh account changes nothing.
export default function NotificationSettings() {
  usePageChrome([{ label: 'Settings', to: '/settings' }, { label: 'Notifications' }]);
  const qc = useQueryClient();
  const { user } = useAuth();
  const { data: prefs = {}, isLoading } = useQuery({ queryKey: ['notifyLeadTimes'], queryFn: getNotifyLeadTimes });

  // Local edits: type key → the raw text in each input. Seeded from the saved/default
  // lead the first time a row is touched.
  const [drafts, setDrafts] = useState({});
  const [undo, setUndo] = useState(null); // { prev } after a save

  const save = useMutation({
    mutationFn: (patch) => setNotifyLeadTimes(patch),
    onSuccess: (_d, patch) => {
      // Capture the pre-save values of exactly the keys we changed, for one-click Undo.
      const prev = {};
      Object.keys(patch).forEach((k) => { prev[k] = prefs?.[k] ?? null; });
      qc.invalidateQueries({ queryKey: ['notifyLeadTimes'] });
      qc.invalidateQueries({ queryKey: ['alerts'] });
      setDrafts({});
      setUndo({ prev });
    },
  });
  const undoMut = useMutation({
    mutationFn: (prev) => setNotifyLeadTimes(prev),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['notifyLeadTimes'] });
      qc.invalidateQueries({ queryKey: ['alerts'] });
      setUndo(null);
    },
  });

  // The interpreted patch of only the rows whose parsed value differs from what's saved.
  const patch = {};
  NOTIFY_TYPES.forEach((t) => {
    const raw = drafts[t.key];
    if (raw === undefined) return; // untouched
    const days = parseLeadTime(raw);
    if (days == null) return; // unparseable — skipped (the row shows the error)
    if (days !== leadDaysFor(prefs, t.key)) patch[t.key] = days;
  });
  const dirty = Object.keys(patch).length > 0;

  return (
    <div className="panel" style={{ maxWidth: 620 }}>
      <div className="panel-head"><strong>Notifications</strong></div>
      <p className="muted" style={{ fontSize: 13, marginTop: 4 }}>
        Choose how far ahead you want each reminder. Type a plain value like
        {' '}<em>3 months</em>, <em>90 days</em>, or <em>1 year</em> — the app reads it and shows the reading below
        each box. These apply to the dashboard alerts and the reminder emails alike.
      </p>

      <div style={{ marginTop: 14, padding: '12px 14px', borderRadius: 10, background: 'var(--panel-soft, #f6f8fa)', border: '1px solid var(--line, #eee)' }}>
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          {DEMO_MODE
            ? 'This is demo mode — no emails are actually sent.'
            : <>Reminder emails go to <strong>{user?.email || 'your sign-in email'}</strong>. Tenants are never emailed automatically — every tenant letter waits behind a ✉ button you click.</>}
          {' '}Turning a whole module off in <strong>Display &amp; features</strong> silences its notifications everywhere.
        </p>
      </div>

      {isLoading ? (
        <p className="muted" style={{ marginTop: 12 }}>Loading…</p>
      ) : (
        <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {NOTIFY_TYPES.map((t) => {
            const savedDays = leadDaysFor(prefs, t.key);
            const raw = drafts[t.key];
            const shown = raw === undefined ? formatLeadDays(savedDays) : raw;
            const parsed = raw === undefined ? savedDays : parseLeadTime(raw);
            const bad = raw !== undefined && raw.trim() !== '' && parsed == null;
            const when = t.kind === 'after' ? 'after' : 'before';
            return (
              <div key={t.key} className="notify-row" style={{ display: 'flex', alignItems: 'flex-start', gap: 14, padding: '10px 0', borderBottom: '1px solid var(--hair)' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 13.5 }}>{t.label}</div>
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 2 }}>{t.hint}</div>
                </div>
                <div style={{ width: 150, flexShrink: 0 }}>
                  <input
                    className="text-input"
                    value={shown}
                    onChange={(e) => setDrafts((d) => ({ ...d, [t.key]: e.target.value }))}
                    placeholder="e.g. 3 months"
                    aria-label={`${t.label} notify lead`}
                  />
                  <div className="muted" style={{ fontSize: 11, marginTop: 3 }}>
                    {bad
                      ? <span style={{ color: 'var(--gold)' }}>couldn’t read that — try “3 months”</span>
                      : parsed != null
                        ? `= ${parsed} day${parsed === 1 ? '' : 's'} ${when} the date`
                        : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 16, display: 'flex', alignItems: 'center', gap: 12 }}>
        <button disabled={!dirty || save.isPending} onClick={() => save.mutate(patch)}>
          {save.isPending ? 'Saving…' : 'Save changes'}
        </button>
        {undo && (
          <UndoStrip
            label="lead times saved"
            busy={undoMut.isPending}
            onUndo={() => undoMut.mutate(undo.prev)}
            onDismiss={() => setUndo(null)}
          />
        )}
      </div>
    </div>
  );
}
