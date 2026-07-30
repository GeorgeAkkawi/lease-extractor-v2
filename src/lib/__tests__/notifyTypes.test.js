// The guarantee George asked for, in a form that can't rot: "make sure for every
// notification theres one" (a column).
//
// The first two cases don't test a hand-written list — they READ the source. Every
// `focus:` literal in alerts.js and every notification `kind` written in api.js (and by
// the SQL crons, which write the same set) has to map to a real column. Adding a new
// alert type without giving it a home fails here rather than silently landing in a
// catch-all nobody looks at.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NOTIFY_COLUMNS, OTHER_COLUMN, columnForRow, groupFeed, rowSubject } from '../notifyTypes';

const src = (f) => readFileSync(join(process.cwd(), 'src/lib', f), 'utf8');

const mapped = new Set();
NOTIFY_COLUMNS.forEach((c) => { c.focuses.forEach((f) => mapped.add(f)); c.kinds.forEach((k) => mapped.add(k)); });

describe('notifyTypes — every notification has a column', () => {
  it('covers every alert focus produced by buildAlerts', () => {
    const focuses = [...src('alerts.js').matchAll(/focus:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(focuses.length).toBeGreaterThan(5); // the regex actually found them
    const unmapped = [...new Set(focuses)].filter((f) => !mapped.has(f));
    expect(unmapped).toEqual([]);
  });

  it('covers every notification kind written into the notifications table', () => {
    // Only inserts INTO notifications count — api.js also uses `kind` for invoices, CAM
    // line items and statement-import entries, which are not feed rows.
    const api = src('api.js');
    const kinds = [...api.matchAll(/from\('notifications'\)[\s\S]{0,400}?kind:\s*'([a-z_]+)'/g)].map((m) => m[1]);
    expect(kinds.length).toBeGreaterThan(0);
    const unmapped = [...new Set(kinds)].filter((k) => !mapped.has(k));
    expect(unmapped).toEqual([]);
  });

  it('has no key or label collisions', () => {
    const keys = NOTIFY_COLUMNS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(OTHER_COLUMN.key);
    // A focus/kind claimed by two columns would make the split ambiguous.
    const claims = NOTIFY_COLUMNS.flatMap((c) => [...c.focuses, ...c.kinds]);
    expect(new Set(claims).size).toBe(claims.length);
  });
});

describe('notifyTypes — grouping', () => {
  const alert = (focus, extra = {}) => ({ type: 'alert', item: { focus, title: 'x — y', ...extra } });
  const notif = (kind, extra = {}) => ({ type: 'notification', item: { kind, title: 'x — y', ...extra } });

  it('returns every registered column even when the feed is empty', () => {
    const cols = groupFeed([]);
    expect(cols.map((c) => c.key)).toEqual(NOTIFY_COLUMNS.map((c) => c.key));
    expect(cols.every((c) => c.rows.length === 0)).toBe(true);
  });

  it('files an alert and its matching notification in the SAME column', () => {
    const cols = groupFeed([alert('renewal'), notif('renewal_decision')]);
    const renewals = cols.find((c) => c.key === 'renewal');
    expect(renewals.rows).toHaveLength(2);
  });

  it('preserves the feed order inside a column', () => {
    const feed = [
      alert('escalation', { title: 'Rent escalation — First' }),
      alert('renewal'),
      alert('escalation', { title: 'Rent escalation — Second' }),
    ];
    const esc = groupFeed(feed).find((c) => c.key === 'escalation');
    expect(esc.rows.map((r) => rowSubject(r))).toEqual(['First', 'Second']);
  });

  it('shows "other" only when something unmapped lands in it', () => {
    expect(groupFeed([alert('renewal')]).some((c) => c.key === 'other')).toBe(false);
    const cols = groupFeed([alert('something_new')]);
    const other = cols.find((c) => c.key === 'other');
    expect(other.rows).toHaveLength(1);
  });

  it('columnForRow takes a feed row or a bare item', () => {
    expect(columnForRow(alert('insurance_chase'))).toBe('insurance');
    expect(columnForRow({ focus: 'insurance_chase' })).toBe('insurance');
    expect(columnForRow({ kind: 'escalation_applied' })).toBe('escalation');
    expect(columnForRow(null)).toBe('other');
  });
});

describe('notifyTypes — rowSubject', () => {
  it('prefers the tenant an alert already carries', () => {
    expect(rowSubject({ focus: 'escalation', tenant: 'Five Points Wings', title: 'Rent escalation — Five Points Wings' }))
      .toBe('Five Points Wings');
  });

  it('names the contract on a contract alert', () => {
    expect(rowSubject({ focus: 'contract', contract_name: 'Snow removal', title: 'Contract ending — Greenleaf' }))
      .toBe('Snow removal');
  });

  it('takes the text after the LAST em dash, so a two-dash title still reads right', () => {
    expect(rowSubject({ focus: 'termination', title: 'Lease ending — no renewal — D & D Dental' }))
      .toBe('D & D Dental');
  });

  it('strips the renewal prompt’s question phrasing', () => {
    expect(rowSubject({ kind: 'renewal_decision', title: 'Is City Dental renewing?' })).toBe('City Dental');
  });

  it('falls back to the whole title rather than going blank', () => {
    expect(rowSubject({ title: 'Something happened' })).toBe('Something happened');
    expect(rowSubject(null)).toBe('');
  });
});
