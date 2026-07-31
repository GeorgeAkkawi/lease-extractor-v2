// How a lease recovers its expenses, stated on the tenant row itself — declared ONCE
// here and used by every tenant list (the per-tenant breakdown, the Rent Ledger, the
// Leases page) so the three can't drift into naming the same fact three different ways.
//
// Two states, never three: `lease_type` is null on every lease that predates 0073, and
// null reads as NET everywhere in the app — so a null row is labeled NNN rather than
// left blank. An unlabeled row would be ambiguous between "triple net" and "nobody has
// recorded which this is", and that ambiguity is exactly what the label exists to kill.
//
// ONE format for both states (George, 2026-07-31: "gross is not the same format as NNN
// on the per tenant break down"). They answer the same question about the same row, so
// they're the same kind of tag and read as one — the word is the whole difference. An
// accent-filled Gross against an outline NNN made them look like two different kinds of
// thing: a status flag on one row, a quiet label on the next. What actually marks the
// gross row is the money beside it — the base cell's "flat $X − $Y expenses" sub-line.
export default function LeaseTypeChip({ gross }) {
  return gross ? (
    <span
      className="lease-type-chip"
      title="Gross lease — one flat rent that already includes property taxes & CAM. This tenant's share is carved OUT of the rent, never billed on top of it."
    >
      Gross
    </span>
  ) : (
    <span
      className="lease-type-chip"
      title="Triple net — this tenant is billed its pro-rata share of property taxes & CAM on top of the base rent."
    >
      NNN
    </span>
  );
}
