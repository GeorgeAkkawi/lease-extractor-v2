// Additional-insured notice helpers (tenant certificates of insurance).
// A tenant's COI should name the landlord as additional insured; when it doesn't,
// InsuranceVault shows a persistent red banner plus a one-time dismissible pop-up.
// Dismissals live in alert_states (server-synced, like the dashboard alerts).

// True when a tenant policy is on file and does NOT name the landlord as additional
// insured. An explicit "No" and "not stated on the document" (null) both warn —
// the same rule the card badge uses.
export function missingAdditionalInsured(policy) {
  return !!policy && policy.additional_insured !== true;
}

// Dismiss-store key for this certificate's pop-up. Replacing a policy updates the
// SAME row (saveInsurance), so the key must include the expiry date: a renewed
// certificate always carries a new expiry, which re-arms the pop-up — dismissed
// stays quiet only until the cert changes.
export function additionalInsuredAlertKey(policy) {
  return `addins:${policy.id}:${policy.expiry_date || 'none'}`;
}
