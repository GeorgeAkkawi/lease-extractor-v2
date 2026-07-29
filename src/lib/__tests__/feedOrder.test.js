// George's note: "sort notifications by most urgent to least urgent by time left to
// handle." The feed used to render every stored notification first (unsorted), then the
// alerts sorted by a bare `a.days - b.days` — which mixed real days-remaining with three
// SORT WEIGHTS that only look like days, so a statement reminder at −3 outranked a lease
// that ended five days ago, and an "escalation applied ✓" notice sat above both.
//
// These tests pin the tier rule that replaced it, at both ends: the pure comparator in
// alerts.js and the merged feed the Overview renders from.
import { describe, it, expect } from 'vitest';
import { alertUrgency, compareUrgencyKeys, URGENCY_TIER } from '../alerts';
import { buildFeed } from '../../pages/DashboardPage';

const sortAlerts = (list) => [...list].sort((a, b) => compareUrgencyKeys(alertUrgency(a), alertUrgency(b)));

// A dated alert carries horizonDays (the notice window it became visible in); the
// weight-based ones deliberately don't — the same field the countdown and the bar test.
const dated = (title, days) => ({ title, days, horizonDays: 183, tone: days < 0 ? 'danger' : 'warn' });

describe('alertUrgency — the tiers', () => {
  it('puts a passed date above a standing problem above a date still ahead', () => {
    const overdue = dated('Tenant in holdover', -5);
    const standing = { title: 'Import your June statement', days: -3, tone: 'info' };   // no horizonDays
    const upcoming = dated('Lease ending', 1);
    expect(sortAlerts([upcoming, standing, overdue]).map((a) => a.title))
      .toEqual(['Tenant in holdover', 'Import your June statement', 'Lease ending']);
  });

  it('ranks the longest-overdue first, and the soonest-due first', () => {
    const out = sortAlerts([dated('a', -2), dated('b', -40), dated('c', 90), dated('d', 3)]);
    expect(out.map((a) => a.title)).toEqual(['b', 'a', 'd', 'c']);
  });

  it('lands all three weight-based focuses in the standing tier, severest first', () => {
    // Their `days` is a weight, not a countdown — so they must never be ordered against a
    // real deadline, and never rank by that number as if it were one.
    const statement = { focus: 'statement_reminder', title: 'statement', days: -1, tone: 'info' };
    const missing = { focus: 'missing_payment', title: 'missing', days: -13, tone: 'danger' };
    const chase = { focus: 'insurance_chase', title: 'chase', days: -25, tone: 'warn' };
    for (const a of [statement, missing, chase]) {
      expect(alertUrgency(a)[0]).toBe(URGENCY_TIER.standing);
    }
    expect(sortAlerts([statement, chase, missing]).map((a) => a.title)).toEqual(['missing', 'chase', 'statement']);
  });

  it('orders equal-severity standing problems by weight — more months float higher', () => {
    const one = { title: 'one month', days: -1, tone: 'info' };
    const three = { title: 'three months', days: -3, tone: 'info' };
    expect(sortAlerts([one, three]).map((a) => a.title)).toEqual(['three months', 'one month']);
  });

  it('is total and stable — no input produces a throw or a shuffle', () => {
    expect(() => alertUrgency(undefined)).not.toThrow();
    expect(() => alertUrgency({})).not.toThrow();
    expect(compareUrgencyKeys(alertUrgency({}), alertUrgency({}))).toBe(0);
    const same = [{ title: 'x', days: 5, horizonDays: 183 }, { title: 'y', days: 5, horizonDays: 183 }];
    expect(sortAlerts(same).map((a) => a.title)).toEqual(['x', 'y']);
  });
});

describe('buildFeed — notifications and alerts as one ordered list', () => {
  const applied = { id: 'n1', kind: 'escalation_applied', title: 'Rent applied', created_at: '2026-07-01T00:00:00Z' };
  const renewed = { id: 'n2', kind: 'renewal_applied', title: 'Lease renewed', created_at: '2026-07-20T00:00:00Z' };
  const decision = { id: 'n3', kind: 'renewal_decision', title: 'Is City Dental renewing?', created_at: '2026-07-05T00:00:00Z' };

  it('sinks the already-happened notices below every alert, newest of them first', () => {
    const feed = buildFeed([applied, renewed], [dated('Tenant in holdover', -5), dated('Lease ending', 30)]);
    expect(feed.map((r) => r.item.title))
      .toEqual(['Tenant in holdover', 'Lease ending', 'Lease renewed', 'Rent applied']);
  });

  it('keeps the renewal Yes/No prompt with the standing problems, not the FYIs', () => {
    // It's a question waiting on an answer — above anything merely upcoming, below a date
    // that has already passed.
    const feed = buildFeed([applied, decision], [dated('Tenant in holdover', -5), dated('Lease ending', 30)]);
    expect(feed.map((r) => r.item.title))
      .toEqual(['Tenant in holdover', 'Is City Dental renewing?', 'Lease ending', 'Rent applied']);
  });

  it('tags each row so the page knows which renderer to use, and loses nothing', () => {
    const feed = buildFeed([applied], [dated('Lease ending', 30)]);
    expect(feed.map((r) => r.type)).toEqual(['alert', 'notification']);
    expect(feed.length).toBe(2);
    expect(buildFeed()).toEqual([]);
  });
});
