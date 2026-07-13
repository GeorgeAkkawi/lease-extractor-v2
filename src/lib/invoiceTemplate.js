import { fmtDate } from './format';

// Builds one combined tenant invoice as plain text: a single amount due
// (base rent + CAM + tax, plus a separate Roof line when the tenant is roof-
// responsible) with an itemized breakdown showing each charge's monthly, annual,
// and per-square-foot (monthly + annual) cost. ALL arithmetic happens here in
// code — no AI, no rounding surprises.
//
// FORMAT RULE — must read right in a PROPORTIONAL font. This text lands in Gmail's
// compose window and in received email, which render in proportional fonts where
// space-padded columns fall apart. So: no padStart/padEnd alignment, never two
// spaces in a row — each charge is ONE line with every figure unit-labeled
// ($/mo · $/yr · $/SF/mo · $/SF/yr) so nothing depends on lining up.
//
// facts: {
//   business: { company_name, address, contact_email, contact_phone } | null,
//   tenant, tenant_contact_name, tenant_email,
//   property, property_address,
//   year,            // the invoice/billing year
//   tax_year,        // the prior year tax/CAM are based on (year - 1)
//   square_footage,
//   base_rent_annual, cam_annual, tax_annual, roof_annual,
//   today, due,      // ISO date strings (passed in so this stays pure/testable)
// }
const usd = (n) => {
  const v = Number(n) || 0;
  const s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-$' : '$') + s;
};

export function buildInvoice(facts) {
  const sf = Number(facts.square_footage) || 0;
  // Months this year's bill actually covers (a mid-year lease start prorates the annual —
  // draft-invoice returns the prorated figures + months_billed). Default 12 = full year, so
  // an ordinary invoice is byte-identical to before. Dividing the annual by the months BILLED
  // (not always 12) keeps "$/mo" the TRUE monthly rent the tenant pays during their occupancy.
  const monthsBilled = Math.min(12, Math.max(1, Number(facts.months_billed) || 12));
  const prorated = monthsBilled < 12;
  // Annual -> the four figures we display for every line.
  const per = (annual) => {
    const a = Number(annual) || 0;
    const m = a / monthsBilled;
    return { m, a, pm: sf ? m / sf : 0, py: sf ? a / sf : 0 };
  };

  const base = per(facts.base_rent_annual);
  const cam = per(facts.cam_annual);
  const tax = per(facts.tax_annual);
  const roof = Number(facts.roof_annual) > 0 ? per(facts.roof_annual) : null;
  // Free/reduced base rent shows as a negative credit line so the tenant sees why the
  // total is lower — the base rent above stays at its full contractual figure.
  const abatement = Number(facts.abatement_annual) > 0 ? per(-Number(facts.abatement_annual)) : null;

  // Which lines bill from a typed ESTIMATE (0060) — drives the "est." tags and the
  // year-end reconciliation note. CAM keeps its "est." tag either way (billed in
  // advance, it is inherently an estimate of the year).
  const est = facts.estimated || {};
  const items = [
    { label: 'Base rent', v: base },
    { label: `CAM (${facts.year} est.)`, v: cam },
  ];
  if (roof) items.push({ label: `Roof (${facts.year}${est.roof ? ' est.' : ''})`, v: roof });
  items.push({ label: `Property tax (${facts.tax_year}${est.tax ? ' est.' : ''})`, v: tax });
  if (abatement) items.push({ label: 'Rent abatement (credit)', v: abatement });

  const totalAnnual = items.reduce((s, it) => s + it.v.a, 0);
  const total = per(totalAnnual);

  // One charge per line, every figure unit-labeled — nothing to line up.
  const line = (label, v) => {
    const figs = [`${usd(v.m)}/mo`, `${usd(v.a)}/yr`];
    if (sf) figs.push(`${usd(v.pm)}/SF/mo`, `${usd(v.py)}/SF/yr`);
    return `• ${label} — ${figs.join(' · ')}`;
  };

  const biz = facts.business || {};
  const invNo = `INV-${facts.year}-${(facts.tenant || 'TEN').replace(/\W+/g, '').slice(0, 4).toUpperCase()}`;
  const bizContact = [biz.contact_email, biz.contact_phone].filter(Boolean).join(' · ');

  const L = [];

  // Letterhead: sending corporation.
  if (biz.company_name) L.push(biz.company_name);
  if (biz.address) L.push(biz.address);
  if (bizContact) L.push(bizContact);
  if (L.length) L.push('');

  L.push(`INVOICE ${invNo}`);
  L.push(`Invoice date: ${fmtDate(facts.today)}`);
  L.push(`Payment due: ${fmtDate(facts.due)} (Net 30)`);
  L.push('');

  L.push('BILL TO');
  L.push([facts.tenant_contact_name, facts.tenant].filter(Boolean).join(' — ') || 'Tenant');
  if (facts.tenant_email) L.push(facts.tenant_email);
  if (facts.property) {
    const premises = `${facts.property}${facts.property_address ? `, ${facts.property_address}` : ''}`;
    L.push(`Premises: ${premises}${sf ? ` (${sf.toLocaleString('en-US')} SF)` : ''}`);
  }
  L.push('');

  // Itemized charges — kept at full detail (monthly / annual / $ per SF).
  L.push('CHARGES');
  items.forEach((it) => L.push(line(it.label, it.v)));
  L.push('');
  L.push(`AMOUNT DUE: ${usd(total.a)}/yr (${usd(total.m)}/mo)`);
  if (prorated) {
    const begins = facts.occupancy_start ? ` — lease begins ${fmtDate(facts.occupancy_start)}` : '';
    L.push(`Prorated${begins} · billed for ${monthsBilled} of 12 months (rates shown are per month).`);
  }
  L.push('');

  // Remittance.
  const remitTo = biz.company_name || 'our office';
  const stop = /[.!?]$/.test(remitTo) ? '' : '.'; // avoid "Inc.." when the name already ends in a period
  const ask = biz.contact_email ? ` Questions? ${biz.contact_email}.` : '';
  L.push(`Please remit ${usd(total.m)}/month to ${remitTo}${stop}${ask} Thank you.`);
  if (est.cam || est.tax || est.roof) {
    L.push('');
    L.push('Note: charges marked "est." are estimated additional rent, reconciled against the actual expenses after year end.');
  }

  return L.join('\n');
}
