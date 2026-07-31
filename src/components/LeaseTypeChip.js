// How a lease recovers its expenses, stated on the tenant row itself — declared ONCE
// here and used by every tenant list (the per-tenant breakdown, the Rent Ledger, the
// Leases page) so the three can't drift into naming the same fact three different ways.
//
// Two states, never three: `lease_type` is null on every lease that predates 0073, and
// null reads as NET everywhere in the app — so a null row is labeled NNN rather than
// left blank. An unlabeled row would be ambiguous between "triple net" and "nobody has
// recorded which this is", and that ambiguity is exactly what the label exists to kill.
//
// Gross carries the accent because it's the one that changes how the money reads (the
// share comes OUT of the rent instead of on top of it); NNN stays an outline chip,
// being the default that most rows are.
export default function LeaseTypeChip({ gross }) {
  return gross ? (
    <span
      className="lease-type-chip gross"
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
