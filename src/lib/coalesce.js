// Run an async job for a key, never twice at once, and never lose the last request.
//
// WHY THIS EXISTS (George, 2026-08-06: "deleting things needs to happen faster").
// Removing one expense line is not one round trip. It is the delete, the kind's total
// re-summed, and then EVERY invoice on the property rebuilt against the new figure —
// because a billable line is a figure a tenant pays, and the stored invoice is a frozen
// copy that does not rebuild itself (CLAUDE.md §1). Deleting five lines therefore fired
// five property-wide rebuilds: five times the wait, and five overlapping writers on the
// same invoice rows, each having read the property's state before the others wrote.
//
// Folding them fixes both. The rebuild still ALWAYS runs after the last delete — that is
// the carry-through rule and it is not negotiable — it just runs once for all of them
// instead of once each.
//
// ⚠ THE FOLD IS ONLY SAFE FOR A JOB THAT RE-READS ITS INPUTS. resyncPropertyBilling
// re-reads the leases, the shares and the expense totals every time, so one merged run
// over the final state gives the same answer as three runs over three intermediate
// states. NEVER coalesce a job that applies a delta to what it finds — three "+$100"s
// folded into one is one +$100, silently.

const running = new Map(); // key -> the run in flight
const queuedJob = new Map(); // key -> the newest job folded behind it
const queuedRun = new Map(); // key -> the promise every folded caller awaits

function start(key, job) {
  const clear = () => {
    if (running.get(key) === p) running.delete(key);
  };
  const p = Promise.resolve()
    .then(job)
    .then(
      (v) => {
        clear();
        return v;
      },
      (e) => {
        clear();
        throw e;
      }
    );
  running.set(key, p);
  return p;
}

export function coalesce(key, job) {
  const current = running.get(key);
  if (!current) return start(key, job);

  // Carry the NEWEST job, not the first one folded: an older closure would rebuild
  // whatever year it captured rather than the one the landlord is now looking at.
  queuedJob.set(key, job);
  if (!queuedRun.has(key)) {
    const p = current
      // A failed run must not swallow the work queued behind it — the queued request
      // is a different change, and it still needs to be carried through.
      .catch(() => {})
      .then(() => {
        const next = queuedJob.get(key);
        queuedJob.delete(key);
        queuedRun.delete(key);
        return start(key, next);
      });
    queuedRun.set(key, p);
  }
  return queuedRun.get(key);
}

// Tests only — a key left running across test files would fold an unrelated call into
// a job from another suite.
export function resetCoalesce() {
  running.clear();
  queuedJob.clear();
  queuedRun.clear();
}
