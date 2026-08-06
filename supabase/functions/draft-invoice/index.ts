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

    // Estimated additional rent (0060): during the year the tenant pays the lease's
    // typed ESTIMATE — the true CAM isn't known until the year closes. Each component
    // falls back to the actual share when no estimate is entered (e.g. the landlord
    // enters only the CAM estimate and lets the known tax figure bill as-is), so a
    // lease with no estimates bills exactly as before. Year-end reconciliation
    // settles estimate-vs-actual separately (kind='reconciliation' invoices).
    //
    // GROSS LEASE (0073) — the flat rent already INCLUDES taxes & CAM, so the tenant's
    // pro-rata share is carved OUT of the rent instead of billed on top: the total the
    // tenant owes is the flat rent, always. Mirrors billedComponents() in
    // src/lib/reconciliation.js — the two must move in the same commit.
    const isGross = cur.lease_type === 'gross';
    const flatAnnual = round(Number(cur.base_rent || 0));
    const grossRoofA = cur.roof_responsible ? round(Number(cur.roof_amt || 0)) : 0;
    const grossCamA = round(Number(cur.cam_amount || 0) + Number(cur.tax_amount || 0));
    // The flat rent is the ceiling — clamp so the carved base floors at 0.
    const grossRoof = Math.min(grossRoofA, flatAnnual);
    const grossCamTax = Math.min(grossCamA, round(flatAnnual - grossRoof));

    const cam = isGross
      ? grossCamTax
      : (cur.est_cam_annual != null ? Number(cur.est_cam_annual) : Number(cur.cam_amount || 0));
    const tax = isGross
      ? 0 // combined into the CAM line, the same convention the estimate editor stores
      : (cur.est_tax_annual != null ? Number(cur.est_tax_annual) : Number(cur.tax_amount || 0));
    const roof = isGross
      ? grossRoof
      : cur.roof_responsible
        ? (cur.est_roof_annual != null ? Number(cur.est_roof_annual) : Number(cur.roof_amt || 0))
        : 0; // separate roof line, roof-responsible tenants only

    // --- Term-aware proration (mirrors occupancyStart + monthlyBases + monthlyScheduleForYear
    // in src/lib/{escalations,abatement}.js, so the invoice total ties to the monthly tracker's
    // schedule to within the balance view's ±5¢ dust clamp). A lease that begins mid-year is
    // billed only for the months it covers (a July-start tenant owes Jul–Dec, not the whole
    // year); a mid-year rent step bills the old rate before it and the new rate after. A
    // full-year lease (occupancy in the past, no mid-year step) prorates to exactly the same
    // figures as before — inTerm = 12, ratio = 1, base = the gross annual.
    const yr = Number(year);
    const parseNoon = (d: string) => new Date(`${String(d).slice(0, 10)}T12:00:00`);
    const monthStartD = (m: number) => new Date(yr, m - 1, 1, 12);
    const monthEndD = (m: number) => new Date(yr, m, 0, 12); // day 0 of next month = last day of this one

    const { data: escs } = await supabase
      .from('rent_escalations')
      .select('effective_date, new_base_rent, status')
      .eq('lease_id', lease_id);
    // occupancyStart = min(lease_start, earliest APPLIED escalation date).
    const occDates: string[] = [];
    if (cur.lease_start) occDates.push(String(cur.lease_start).slice(0, 10));
    for (const e of (escs ?? []) as any[]) if (e.status === 'applied' && e.effective_date) occDates.push(String(e.effective_date).slice(0, 10));
    occDates.sort();
    const occIso = occDates.length ? occDates[0] : null;
    const occ = occIso ? parseNoon(occIso) : null;

    // monthlyBases: the annual base rent in effect each month (era-aware — base_rent is the
    // live authoritative rent for the current era; the ledger supplies historical segments).
    const grossBase = Number(cur.base_rent || 0);
    const applied = ((escs ?? []) as any[])
      .filter((e) => e.status === 'applied' && e.effective_date && e.new_base_rent != null)
      .map((e) => ({ t: parseNoon(e.effective_date).getTime(), rent: Number(e.new_base_rent) || 0 }))
      .sort((a, b) => a.t - b.t);
    const maxT = applied.length ? applied[applied.length - 1].t : null;
    const baseForMonth = (m: number) => {
      const ref = monthStartD(m).getTime();
      const prior = applied.filter((s) => s.t <= ref);
      if (!prior.length) return grossBase;
      const latest = prior[prior.length - 1];
      return latest.t === maxT ? grossBase : latest.rent;
    };

    // The CAM & tax / roof estimate in effect each month (0089) — the exact twin of
    // baseForMonth above, and of monthlyEstimates() in src/lib/reconciliation.js. Same era
    // rule: the live scalar is authoritative for the current era, the dated ledger answers
    // for any earlier segment. An EMPTY ledger returns the live figure for all twelve months,
    // which is byte-for-byte what this function did before 0089.
    //
    // ⚠ This and reconciliation.js are the JS↔TS mirror pair for the estimate (CLAUDE.md §3).
    // Change one without the other and a freshly drafted invoice disagrees with the resync
    // that maintains it — the drafted one re-pricing months the resync deliberately left alone.
    const { data: estRows } = await supabase
      .from('lease_estimates')
      .select('effective_date, cam_tax_annual, roof_annual, cam_tax_none')
      .eq('lease_id', lease_id);
    // `actual` is what an era with NO estimate is billed at (0090) — the tenant's plain
    // pro-rata share, which is exactly what the `cam`/`roof` fallbacks above resolve to when
    // the lease carries no estimate. A row with cam_tax_none = true carries no figure and
    // means precisely that era.
    const estSeries = (key: string, live: number, actual: number, noneKey?: string) => {
      const dated = ((estRows ?? []) as any[])
        .filter((e) => e && e.effective_date && (e[key] != null || (noneKey && e[noneKey] === true)))
        .map((e) => ({
          t: parseNoon(e.effective_date).getTime(),
          v: e[key] != null ? round(Number(e[key]) || 0) : null,
        }))
        .sort((a, b) => a.t - b.t);
      if (!dated.length) return () => live;
      const last = dated[dated.length - 1].t;
      return (m: number) => {
        const ref = monthStartD(m).getTime();
        const prior = dated.filter((r) => r.t <= ref);
        if (!prior.length) return live;
        const latest = prior[prior.length - 1];
        if (latest.t === last) return live;
        return latest.v == null ? round(actual) : latest.v;
      };
    };
    // Gross leases read no estimate at all (the carve above is the answer), so the ledger has
    // nothing to say about them and the live carve stands for every month.
    const actualCamTax = round(Number(cur.cam_amount || 0) + Number(cur.tax_amount || 0));
    const actualRoof = cur.roof_responsible ? round(Number(cur.roof_amt || 0)) : 0;
    const camTaxForMonth = isGross
      ? () => round(cam + tax)
      : estSeries('cam_tax_annual', round(cam + tax), actualCamTax, 'cam_tax_none');
    // ⚠ THE roof_responsible GATE IS PART OF THE MIRROR. monthlyEstimates (reconciliation.js)
    // returns an all-zero roof series for a tenant who isn't roof-responsible, "whatever any
    // row says" — this had no such gate, so a lease that WAS roof-responsible, had a dated roof
    // estimate written, then had the flag turned off would still bill roof for the superseded
    // months here while the ledger and the resync that maintains the invoice both said $0.
    // The live `roof` scalar is already 0 in that case, which is exactly why the gap only
    // showed on a HISTORICAL era — the one branch that reads the row instead of the scalar.
    const roofForMonth = isGross
      ? () => roof
      : cur.roof_responsible
        ? estSeries('roof_annual', roof, actualRoof)
        : () => 0;

    // Per-month base abatement credit (mirrors abatement.js — strongest window wins).
    const { data: abs } = await supabase
      .from('rent_abatements')
      .select('start_date, end_date, kind, value')
      .eq('lease_id', lease_id);
    const covers = (ab: any, m: number) => {
      const s = ab.start_date ? parseNoon(ab.start_date) : null;
      const e = ab.end_date ? parseNoon(ab.end_date) : null;
      if (!s && !e) return false;
      if (s && s > monthEndD(m)) return false;
      if (e && e < monthStartD(m)) return false;
      return true;
    };
    const reducedBaseFor = (full: number, ab: any) => {
      switch (ab?.kind) {
        case 'percent': { const p = Math.min(100, Math.max(0, Number(ab.value) || 0)); return round(full * (1 - p / 100)); }
        case 'amount': return round(Math.min(full, Math.max(0, Number(ab.value) || 0)));
        default: return 0; // 'free'
      }
    };
    const monthCredit = (m: number, full: number) => {
      let best = -1;
      for (const ab of (abs ?? []) as any[]) {
        if (!covers(ab, m)) continue;
        const c = round(full - reducedBaseFor(full, ab));
        if (c > best) best = c;
      }
      return best > 0 ? best : 0;
    };

    let inTerm = 0;
    let proratedBaseGross = 0;
    let proratedAbatement = 0;
    // Σ of the in-term months' estimate. With no dated ledger every month carries the same
    // rate and these land on exactly `cam * ratio` — the old arithmetic, to the cent.
    let proratedCamTax = 0;
    let proratedRoof = 0;
    for (let m = 1; m <= 12; m++) {
      if (occ && monthEndD(m) < occ) continue; // before the tenancy began — not billed
      inTerm++;
      const fullMonthly = baseForMonth(m) / 12;
      proratedBaseGross += fullMonthly;
      proratedAbatement += monthCredit(m, fullMonthly);
      proratedCamTax += camTaxForMonth(m) / 12;
      proratedRoof += roofForMonth(m) / 12;
    }
    const ratio = inTerm / 12;

    // Gross: the components come OUT of the prorated flat rent, so base + cam + tax +
    // roof still sums to the flat figure the tenant actually pays. Net: base is the
    // rent and the components ride on top, exactly as before.
    //
    // The cam/tax split stays as read whenever nothing was dated (a legacy lease with the two
    // entered separately keeps them separate); once the ledger has moved the figure the
    // combined amount rides on cam with tax zeroed — the storage convention every reader of
    // these columns already assumes, and the same rule resyncYearBillingToEstimate follows.
    const segmented = Math.abs(round(proratedCamTax) - round((cam + tax) * ratio)) > 0.005;
    const camA = segmented ? round(proratedCamTax) : round(cam * ratio);
    const taxA = segmented ? 0 : round(tax * ratio);
    const roofA = round(proratedRoof);
    const baseA = isGross
      ? round(proratedBaseGross - camA - taxA - roofA)
      : round(proratedBaseGross);

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
      base_rent_annual: baseA,                           // gross: flat rent MINUS the carved share
      cam_annual: camA,
      tax_annual: taxA,
      roof_annual: roofA,
      abatement_annual: round(proratedAbatement),        // free/reduced base rent credited off this year's bill
      // Proration transparency for the invoice document (a "lease begins {date}" note when < 12).
      occupancy_start: occIso,
      months_billed: inTerm,
      // Drives the invoice document's single "Rent (gross lease — property taxes & CAM
      // included)" line: the stored components stay carved (the ledger reads them back
      // to split each month), but the printed bill reads the way the lease does.
      lease_type: cur.lease_type ?? null,
      // which lines are estimates (drives the "est." labels + reconciliation note).
      // A gross lease bills no estimate at all — nothing is labelled "est." and the
      // year-end reconciliation footnote is suppressed.
      estimated: isGross ? { cam: false, tax: false, roof: false } : {
        cam: cur.est_cam_annual != null,
        tax: cur.est_tax_annual != null,
        roof: cur.roof_responsible && cur.est_roof_annual != null,
      },
      today: now.toISOString().slice(0, 10),
      due: due.toISOString().slice(0, 10),
    };

    return json({ facts, from: business?.contact_email ?? null });
  } catch (e) {
    return serverError(e, 'draft-invoice');
  }
});
