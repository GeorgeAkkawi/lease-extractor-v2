---
name: audit
description: >-
  Audit Amlak for the bugs a diff review cannot see — a state change with no
  visible consequence, a figure held back with nothing saying so, a result the
  user cannot find or is gated away from. Runs the mechanical wiring sweeps and,
  on request, reads a named surface against CLAUDE.md's ten "user's hands"
  questions. Use before onboarding a new client, before a release, or whenever
  George asks for an audit or review of what is already live.
disable-model-invocation: true
---

# Audit Amlak

**What this is for, and why `/code-review` is not it.** `/code-review` reviews a **diff** — it
finds code that is wrong. This finds code that is *right* and still fails the person using it.
The bug that created this skill: a landlord clicked "Revenue always" on a $100 overpayment, the
write succeeded, the money moved into the live income figures — and the box stayed gold, because
the gold fill meant "cash ≠ bill" (still true) and only a 3px ring meant "unanswered". Nothing
in any diff was defective. The defect was a real state change with no legible consequence.

## Modes

- `/audit` — the wiring sweeps. Fast, whole-codebase, no agents.
- `/audit <surface>` — one deep pass over a named surface (`ledger`, `financials`, `dashboard`,
  `invoices`, `reconciliation`, `signup`, `firstlease`, `firstpayment`, or any file/feature).
- `/audit all` — fan out one agent per surface, then adversarially verify each finding. Ask
  George before doing this: it is many agents and a lot of tokens.

---

## Mode 1 — the wiring sweeps

Run `npx vitest run src/lib/__tests__/wiring.test.js`. That file **is** the sweep suite: it reads
the source and asserts nine of CLAUDE.md's own invariants (alert focuses that reach a page are
explained there · query keys wired in both directions · `api.js` exports have callers · every
optional module has a backfill migration · the demo mock mirrors every SQL view · the site and app
design tokens agree · history event types are in all three registries · migrations are uniquely
numbered).

Then report:

1. **Anything red.** A red sweep is a new regression — name it and stop.
2. **The `KNOWN` lists.** Each entry is a real hit deliberately left recorded rather than fixed, so
   George can pick. Read them out with their reasons; anything he clears becomes a fix.

⚠ **When you add a sweep, give it a non-vacuity guard** (`expect(found.length).toBeGreaterThan(N)`)
and **prove it breakable** — break the thing it watches, confirm red, restore, confirm green.
A sweep whose regex quietly stops matching passes forever while asserting the rule is kept, which
is worse than not having it. This has already caught one too-weak sweep in this file.

## Mode 2 — a surface pass

Read the surface end to end — the page, its components, the mutations, the invalidations, and what
repaints — and answer **all ten** questions from CLAUDE.md's *"Following the change through the
user's hands"*. Questions **6** (*where do I look*) and **7** (*can the user see it at all*) are the
two the bug above failed, and they are the two most often skipped.

Hunt these shapes specifically. Every one has actually happened in this repo:

| Shape | What it looks like |
|---|---|
| A click with no visible consequence | The write lands; the screen says nothing, or says it in a way nobody would notice |
| A write nobody reads | `statement_lines.disposition` was stored for two weeks with no reader — a filed line left the screen forever |
| A figure held out of a total silently | Money withheld from income with nothing on screen saying so is indistinguishable from the app losing it |
| A result behind a gate | `features.js` modules, `dashboardWidgets` hidden panels, a tab that disappears with its module. Paying for a result the app then refuses to render is the worst version |
| Invisible in production, fine in the demo | The demo seeds no `user_preferences` row, so it runs the "everything on" path. That is how `announcements` shipped invisible |
| Two copies of one rule, drifted | CLAUDE.md §3 lists the mirrors that must move together |
| A registry entry missing | Renders as a bare slug, an empty box, or a dismissal key that collides |

**A finding must state what a client would actually experience.** *"Query key not invalidated"* is
not a finding. *"After adding a property, the sidebar keeps showing the old list until a hard
refresh"* is. Cite `file:line`. Do not report style, naming or test coverage.

**Do not report what CLAUDE.md or a code comment documents as deliberate.** That file records many
decisions that look like bugs and are not — the asymmetry between `monthsBehind` and `owesToDate`,
a tagged overpayment raising no credit, `billable = false` keeping owner draws inert. Read before
reporting.

⚠ **`src/lib/incomeExpense.js` contains a literal NUL byte**, so plain `grep` treats it as binary.
Use `grep -a` throughout.

## Mode 3 — the fan-out

One agent per surface in parallel, each doing Mode 2, then **one adversarial verifier per HIGH/MED
finding, prompted to refute it**. A plausible-but-wrong finding costs more of George's time than a
missed one, so verifiers default to refuting when unsure. State any cap out loud — a silently
truncated audit reads as "we covered everything".

Agents must not write files into `src/`. If a scratch probe is genuinely needed, put it in the
session scratchpad and say so.

---

## Delivering it

Write `docs/audit-YYYY-MM-DD.md`, newest findings first, in the same greppable form as
`docs/deploy-log.md`. Every finding carries:

**severity · what a new client sees · file:line · the fix · how it would be pinned**

Then rank, and **let George pick**. Do not fix on your own authority — an audit that arrives as a
completed refactor is impossible to review. Close with CLAUDE.md's standing question: what did this
make **redundant**?
