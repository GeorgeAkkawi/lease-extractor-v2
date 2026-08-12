// The half of the lease review that needs no AI at all.
//
// Some risks aren't in the lease's wording — they're in the state of the record: an option
// whose notice window closed, a certificate that expired, a tenant billed for the roof with
// no estimate behind it. Those are arithmetic, so they're computed here for free, refresh
// the moment the underlying data changes, and can never be stale the way a saved AI read can.
//
// Every finding uses the same shape as an AI flag ({ key, severity, title, note }) so the
// one strip on the lease page renders both without caring where a finding came from. The
// extra `panel` field names the section that fixes it, so a finding can scroll the landlord
// to the thing they need to change.
import { optionLapseReason, renewalFirstYearRent } from './renewals';
import { missingAdditionalInsured } from './insuranceNotices';
import { money } from './format';

const RANK = { high: 0, medium: 1, info: 2 };

// The browser's LOCAL calendar date (yyyy-mm-dd) — same rule as localDateIso in api.js,
// inlined so this leaf stays free of the supabase client that module pulls in (the way
// alerts.js inlines its own featureOn). Every check takes todayIso explicitly in tests.
function todayLocalIso(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// A renewal option whose stated rent falls this far below today's rent is worth a look
// even before it's confirmed — the confirm dialog blocks it, but nobody wants to discover
// it on the day. Half a percent of slack keeps a penny-rounded flat renewal quiet.
const DECREASE_TOLERANCE = 0.005;

export function computeLeaseRisks({ lease, escalations, renewals, insurance, todayIso } = {}) {
  if (!lease) return [];
  const today = todayIso || todayLocalIso();
  const out = [];
  const add = (key, severity, title, note, panel) => out.push({ key, severity, title, note, panel, source: 'code' });

  const termEnd = lease.lease_termination_date || null;
  const currentRent = Number(lease.base_rent) || 0;

  // --- The term itself ---------------------------------------------------------
  if (!lease.lease_start) {
    add('no_start_date', 'medium', 'No lease start date on file',
      'Without a start date the rent schedule can’t be placed on the calendar — escalations stay undated and nothing bills on time. Set it on this page and the whole schedule dates itself.',
      'terms');
  }
  if (!termEnd) {
    add('no_term_end', 'medium', 'No term-end date on file',
      'Nothing can warn you this lease is ending, and a renewal has no date to extend from. Renewals can’t be confirmed at all until it’s set.',
      'terms');
  } else if (termEnd < today && lease.is_active !== false) {
    add('holdover', 'high', 'Tenant is in holdover',
      `The term ended ${termEnd} and the tenant is still in possession. Until the lease is extended or renewed, the tenancy is running on the holdover clause — check what rent that clause actually entitles you to.`,
      'terms');
  }

  // --- Renewal options ---------------------------------------------------------
  const pending = (renewals || []).filter((r) => r.status === 'pending');
  for (const r of pending) {
    const label = r.option_label || 'A renewal option';
    const lapse = optionLapseReason(r, termEnd, today);
    if (lapse === 'notice_passed') {
      add(`option_lapsed_${r.id}`, 'medium', `${label} has lapsed`,
        `Its notice deadline (${r.notice_by_date}) passed long before this term ends, so it belongs to an earlier term the lease has since been extended past. It is no longer a live choice — close it out so it stops looking like one.`,
        'renewals');
    } else if (lapse === 'term_ended') {
      add(`option_lapsed_${r.id}`, 'medium', `${label} has lapsed`,
        'The term it would have extended has already ended, so the option was never exercised. Mark it declined to clear it from the record.',
        'renewals');
    } else {
      if (!r.notice_by_date) {
        add(`option_no_notice_${r.id}`, 'info', `${label} has no notice deadline`,
          'Nothing can remind you before the window closes. If the lease states a notice period ("180 days prior to expiration"), enter the date it works out to.',
          'renewals');
      }
      if (currentRent > 0) {
        const next = renewalFirstYearRent(r, currentRent);
        if (next > 0 && next < currentRent * (1 - DECREASE_TOLERANCE)) {
          add(`option_below_market_${r.id}`, 'high', `${label} books LESS than today’s rent`,
            `It would set rent at ${money(next)}/yr against the ${money(currentRent)} in effect now — ${money(currentRent - next)}/yr less. A stated rent well below today’s usually means the option quotes an earlier term’s figure.`,
            'renewals');
        }
      }
    }
  }

  // --- Insurance ----------------------------------------------------------------
  // `insurance` is this lease's tenant policy (or null). Undefined means the caller
  // didn't load it — usually because the module is switched off — so stay quiet.
  if (insurance !== undefined) {
    if (!insurance) {
      add('no_coi', 'high', 'No certificate of insurance on file',
        'Nothing on record shows this tenant carries liability cover. A claim from their operations would land on your policy first.',
        'insurance');
    } else {
      if (insurance.expiry_date && String(insurance.expiry_date) < today) {
        add('coi_expired', 'high', 'Certificate of insurance has expired',
          `The certificate on file${insurance.insurer ? ` from ${insurance.insurer}` : ''} expired ${insurance.expiry_date}. Request the renewed one — the Insurance panel below drafts the letter.`,
          'insurance');
      }
      if (missingAdditionalInsured(insurance)) {
        add('not_additional_insured', 'high', 'You are not named as additional insured',
          insurance.additional_insured === false
            ? 'The certificate explicitly does not name the landlord as an additional insured, so their policy will not defend you in a claim arising from their premises.'
            : 'The certificate on file doesn’t state that the landlord is an additional insured. Ask their agent for an endorsement that does.',
          'insurance');
      }
    }
  }

  // --- Billing shape ------------------------------------------------------------
  // A lease flagged roof-responsible with no roof estimate falls back to the tenant's
  // tiny actual share, which routinely under-bills — the Infinite Mobile case (2026-07-24).
  if (lease.roof_responsible === true && lease.est_roof_annual == null) {
    add('roof_no_estimate', 'medium', 'Billed for roof with no roof estimate',
      'This tenant is marked roof-responsible but no roof estimate is set, so the roof line bills from actuals rather than an estimate. If the roof cost is already inside the combined CAM & tax estimate, set the roof estimate to 0 to say so.',
      'financials');
  }
  if (currentRent <= 0) {
    add('no_base_rent', 'high', 'No base rent on file',
      'Nothing bills for this tenant and they appear in no rent roll. Enter the annual base rent to bring them into the figures.',
      'terms');
  }
  // A scheduled step dated before today means the engine hasn't caught up — the rent on
  // this page is behind what the lease says the tenant owes.
  const overdueStep = (escalations || []).find(
    (e) => e.status === 'scheduled' && e.effective_date && String(e.effective_date) < today
      && (!termEnd || String(e.effective_date) < String(termEnd)),
  );
  if (overdueStep) {
    add('rent_step_not_applied', 'high', 'A rent increase is past due and not applied',
      `A step dated ${overdueStep.effective_date} is still scheduled, so this tenant is being billed at the old rate. Open the rent-escalations panel to apply it.`,
      'escalations');
  }

  return out.sort((a, b) => (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3));
}

// How much of the document the AI review was actually able to read.
//
// The transcription pipeline leaves a VISIBLE marker wherever a page range failed —
// "[Pages 11-20 could not be read for search…]" — added by the 2026-07-21 parallel-chunk
// fix precisely so a hole in the text is visible rather than silent. Until now nothing
// consulted them, and that mattered: the red-flag review's most valuable findings are
// the ones that say a lease is SILENT on something ("no personal guarantee", "no
// security deposit"). Silence is exactly what an unread page looks like. So a review run
// over a partial transcript reports missing protections that may simply be on a page
// that never transcribed — a confident-sounding finding built on nothing.
//
// Found on live data: one lease had pages 1-20 of 36 missing, and another transcribed
// only a scan of a driver's licence, yet returned five "the lease doesn't say" findings.
//
// Reads the stored text, so it judges reviews saved BEFORE this existed too — no
// re-run, and no new column.
const GAP_RE = /\[Pages?\s+[\d\s\-–—]+?\s+could not be read[^\]]*\]/gi;
const PAGES_RE = /\[Pages?\s+([\d\s\-–—]+?)\s+could not be read/i;

export function transcriptGaps(text) {
  const t = String(text || '');
  const markers = t.match(GAP_RE) || [];
  const pages = markers.map((m) => (m.match(PAGES_RE)?.[1] || '').trim()).filter(Boolean);
  // What survives once the markers themselves are removed — the text there was actually
  // something to judge from. A transcript that is nothing BUT gap markers has a real
  // length and no content, which is the case worth catching.
  const readableLength = t.replace(GAP_RE, '').trim().length;
  return { partial: markers.length > 0, pages, readableLength };
}

// `cappedLeases` lived here until 2026-08-12. It pulled every lease carrying the review's
// `cam_capped` flag so "What it cost you" could warn that a capped tenant reimburses less
// than the pro-rata share the table counts. George had the caveat removed outright, and the
// selector went with it rather than becoming a function nothing calls. Nothing about the
// flag changed: it is still raised, still stored on `ai_review`, and still rendered — with
// its quote and a dismiss — by LeaseReviewStrip on the lease's own page.

/**
 * What a saved AI review amounts to, in the two numbers every surface needs: how many
 * points were raised and how many of them are severe.
 *
 * ONE implementation on purpose. The sweep's result list and the tenant-row badge are the
 * same sentence said in two places, and a second copy would let the list say "3 to look
 * at" while the row it links to says 5. `null` means NEVER REVIEWED, which is a different
 * statement from `{ total: 0 }` ("read, nothing flagged") — the tenant list draws no badge
 * for the first and can say "nothing flagged" for the second. Collapsing the two would
 * make an unreviewed lease look clean, which is the one reading that costs money.
 *
 * Reads ONLY the AI half (`leases.ai_review`). The free code-side checks
 * (computeLeaseRisks) are recomputed live on the lease page and are deliberately not
 * counted here: the list query doesn't carry the escalations, renewals and insurance rows
 * they need, so counting them would make the badge disagree with the panel it points at.
 */
export function reviewSummary(lease) {
  const review = lease?.ai_review;
  if (!review || typeof review !== 'object') return null;
  const flags = Array.isArray(review.flags) ? review.flags : [];
  // Findings the landlord has marked read on the lease page. `dismissed_at` is the earlier
  // whole-review stamp, kept readable so rows written before per-finding dismissal shipped
  // still count as fully read rather than springing back to a full badge.
  const keys = Array.isArray(review.dismissed_keys) ? review.dismissed_keys : [];
  const allRead = !!review.dismissed_at;
  const live = allRead ? [] : flags.filter((f) => !keys.includes(f?.key));
  return {
    // ⚠ EVERY COUNT HERE IS OF WHAT IS STILL OUTSTANDING, not of what the review found.
    // That is the whole point: the tenant-row badge has to fall as findings are read, and
    // dropping the one high finding has to take `high` down with it.
    total: live.length,
    high: live.filter((f) => f?.severity === 'high').length,
    dismissed: flags.length - live.length,
    found: flags.length,
    reviewedAt: review.reviewed_at || null,
    titles: live.map((f) => f?.title).filter(Boolean),
  };
}
