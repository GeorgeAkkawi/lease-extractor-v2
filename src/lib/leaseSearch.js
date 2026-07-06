// Tenant ordering used everywhere a property's tenants are listed.

// Soonest term end first; leases with no end date sort last; ties alphabetical
// by tenant.
export function byTermEnd(a, b) {
  const da = a?.lease_termination_date;
  const db = b?.lease_termination_date;
  if (da && db && da !== db) return String(da).localeCompare(String(db));
  if (!da && db) return 1;
  if (da && !db) return -1;
  return String(a?.tenant_name || '').localeCompare(String(b?.tenant_name || ''));
}
