// The landlord-side red-flag checklist for a SERVICE / MAINTENANCE contract — the
// sibling of LEASE_FLAG_DEFS, and read by the same parser (leaseFlags.js takes a `defs`
// argument so there is exactly ONE flag engine and two vocabularies).
//
// Same convention throughout, and the prompt says it twice: **yes = the concern applies.**
// Every key is phrased so "yes" is the answer the landlord should look at. no/unclear never
// raise a flag: this is a prompt to go look, never an accusation, and a contract that simply
// wasn't read clearly should stay quiet rather than invent a problem.
//
// Why these ten and not a lease's ten: a service contract costs money in different ways. A
// lease's risk is the tenant leaving; a contract's risk is that it QUIETLY CONTINUES —
// renewing itself on a notice window nobody watched, at a fee nobody capped, for work that
// excludes the thing you actually needed done.
//
// This is NOT legal advice, and the UI says so. It's a reading aid.

export const CONTRACT_FLAG_DEFS = [
  {
    key: 'auto_renew_short_notice',
    severity: 'high',
    title: 'Renews itself on a short notice window',
    note: 'The agreement renews automatically unless you cancel inside a narrow window before the term ends. Miss the date and you are committed to another full term at the vendor’s figure — this is the deadline on a service contract that most often costs money.',
  },
  {
    key: 'evergreen_no_end',
    severity: 'high',
    title: 'No end date — it runs until cancelled',
    note: 'The contract has no expiry: it continues indefinitely until somebody terminates it. Nothing will ever prompt you to re-tender the work or re-price it against the market.',
  },
  {
    key: 'uncapped_escalation',
    severity: 'high',
    title: 'Fee increases are uncapped',
    note: 'The fee rises by CPI, by the vendor’s prevailing rates, or by an unstated amount, with no ceiling. An uncapped increase flows straight into CAM and therefore into what your tenants are billed.',
  },
  {
    key: 'landlord_indemnifies_vendor',
    severity: 'high',
    title: 'You indemnify the vendor',
    note: 'The indemnity runs the wrong way: you agree to cover the vendor’s losses, including — in the widest wording — ones arising from their own work. On a snow or roof contract this is the clause that turns a slip-and-fall into your claim.',
  },
  {
    key: 'no_vendor_insurance',
    severity: 'high',
    title: 'No insurance required of the vendor',
    note: 'The contract does not require the vendor to carry liability insurance, or does not require you to be named as an additional insured. A claim arising from their work then lands on your policy.',
  },
  {
    key: 'no_termination_for_convenience',
    severity: 'medium',
    title: 'You cannot cancel for poor performance',
    note: 'There is no right to terminate for convenience or on notice — only for a defined breach, if that. You are locked in for the term whatever the standard of work.',
  },
  {
    key: 'no_lien_waiver',
    severity: 'medium',
    title: 'No lien waiver from the vendor',
    note: 'Nothing requires the vendor (or their subcontractors) to waive mechanics’ lien rights against the property on payment. An unpaid sub can lien your building over work you already paid the contractor for.',
  },
  {
    key: 'price_increase_without_notice',
    severity: 'medium',
    title: 'Price can change without notice',
    note: 'The vendor may adjust the fee without a stated period of written notice, so a rise can appear on an invoice you have already committed to CAM for the year.',
  },
  {
    key: 'minimum_term_penalty',
    severity: 'medium',
    title: 'Early termination carries a penalty',
    note: 'Cancelling before the end of the term triggers a fee, the balance of the term, or a clawback of discounts. Worth knowing the number before you sign, not after you want out.',
  },
  {
    key: 'scope_excludes_major_items',
    severity: 'info',
    title: 'The headline fee excludes major work',
    note: 'Significant items are carved out of the quoted fee and billed separately — deep-snow or per-tonne salt, storm cleanup, parts and materials, after-hours call-outs. The "fixed" price is not what the year will cost.',
  },
];

// The one-line test behind each key, phrased so "yes" is always the concern. Exported
// through flagInstructionFor() in leaseFlags.js, which builds the prompt block.
export function contractFlagQuestion(key) {
  switch (key) {
    case 'auto_renew_short_notice': return 'the contract RENEWS AUTOMATICALLY (evergreen / successive terms) unless cancelled, and the cancellation notice window is 60 days or shorter';
    case 'evergreen_no_end': return 'the contract states NO end / expiration date and continues until terminated';
    case 'uncapped_escalation': return 'the fee may increase with NO stated cap — by CPI, by the vendor\'s "then-prevailing rates", or by an amount the contract does not fix';
    case 'landlord_indemnifies_vendor': return 'the OWNER / landlord indemnifies or holds harmless the VENDOR (rather than the other way round)';
    case 'no_vendor_insurance': return 'the vendor is NOT required to carry liability insurance, or NOT required to name the owner as an additional insured';
    case 'no_termination_for_convenience': return 'the owner has NO right to terminate for convenience or on notice (only for a defined breach, or not at all)';
    case 'no_lien_waiver': return 'the contract does NOT require the vendor or its subcontractors to waive or release mechanics\' lien rights on payment';
    case 'price_increase_without_notice': return 'the vendor may change the price WITHOUT a stated period of prior written notice';
    case 'minimum_term_penalty': return 'ending the contract early triggers a PENALTY, an early-termination fee, or liability for the balance of the term';
    case 'scope_excludes_major_items': return 'significant work is EXCLUDED from the quoted fee and billed separately (snow hauling, extra salt applications, storm cleanup, parts / materials, after-hours calls)';
    default: return 'the concern applies';
  }
}
