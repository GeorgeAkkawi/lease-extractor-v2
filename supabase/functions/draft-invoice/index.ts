// Returns the figures for one combined tenant invoice. ALL dollar amounts are
// recomputed server-side from v_tenant_shares (never trust the client). The
// frontend renders these with the shared invoice template — the invoice is a
// deterministic numeric table, so no model call is needed.
//
// Billing logic: charges are billed on the current-year invoice. The landlord
// maintains the property tax figure based on the prior year's assessment (taxes
// bill in arrears); it's labeled with the lagging tax year. A roof-responsible
// tenant's roof share is a separate line.
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { cors } from '../_shared/cors.ts';
import { enforceRateLimit } from '../_shared/ratelimit.ts';

Deno.serve(async (req) => {
  const { preflight, json, serverError } = cors(req);
  if (req.method === 'OPTIONS') return preflight();
  try {
    // Not a paid (model) call, but rate-limit anyway so the endpoint can't be
    // spammed for DB load. Generous limit since invoices are cheap to compute.
    const limited = await enforceRateLimit(req, 60, 60);
    if (limited) return limited;

    const { lease_id, year } = await req.json();
    if (!lease_id || !year) return json({ error: 'lease_id and year required' }, 400);

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    );

    const priorYear = Number(year) - 1;

    // Current-year share: base rent (effective), tax, CAM, roof, SF, tenant identity.
    const { data: cur, error: curErr } = await supabase
      .from('v_tenant_shares')
      .select('*')
      .eq('lease_id', lease_id)
      .eq('year', year)
      .maybeSingle();
    if (curErr) return json({ error: curErr.message }, 500);
    if (!cur) return json({ error: 'No financial data for this tenant/year.' }, 404);

    const { data: prop } = await supabase
      .from('properties')
      .select('name, address, corporation_id')
      .eq('id', cur.property_id)
      .maybeSingle();

    // The owning corporation is the sending entity (letterhead / remit-to).
    let business = null;
    if (prop?.corporation_id) {
      const { data: corp } = await supabase
        .from('corporations')
        .select('name, address, contact_email, contact_phone')
        .eq('id', prop.corporation_id)
        .maybeSingle();
      if (corp) {
        business = {
          company_name: corp.name,
          address: corp.address,
          contact_email: corp.contact_email,
          contact_phone: corp.contact_phone,
        };
      }
    }

    const round = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
    const now = new Date();
    const due = new Date(now.getTime() + 30 * 86400000);
    const roof = cur.roof_responsible ? Number(cur.roof_amt || 0) : 0; // separate roof line

    const facts = {
      business,
      tenant: cur.tenant_name,
      tenant_contact_name: cur.tenant_contact_name ?? null,
      tenant_email: cur.tenant_email ?? null,
      property: prop?.name ?? '',
      property_address: prop?.address ?? '',
      year: Number(year),
      tax_year: priorYear, // taxes lag a year — used for the tax line label + note
      square_footage: cur.square_footage,
      base_rent_annual: round(cur.base_rent || 0),
      cam_annual: round(cur.cam_amount || 0),
      tax_annual: round(cur.tax_amount || 0),
      roof_annual: round(roof),
      abatement_annual: round(cur.abatement_amount || 0), // free/reduced base rent credited off this year's bill
      today: now.toISOString().slice(0, 10),
      due: due.toISOString().slice(0, 10),
    };

    return json({ facts, from: business?.contact_email ?? null });
  } catch (e) {
    return serverError(e, 'draft-invoice');
  }
});
