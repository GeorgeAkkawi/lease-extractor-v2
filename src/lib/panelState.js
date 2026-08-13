import { useCallback, useState } from 'react';

// Which sections the landlord has folded shut, remembered between visits.
//
// George, 2026-08-12: "make all the tabs on the financials page and individual tenant
// pages collapsible". A fold that forgets itself is worse than no fold at all — he'd
// re-close the same four sections on every visit — so the choice lives here.
//
// ⚠ ONLY THE SECTIONS HE HAS ACTUALLY TOUCHED ARE STORED. A section he has never clicked
// is absent from the map and follows the default its caller passes. Storing every section
// on first render would freeze today's defaults into his browser forever: change a
// default later and it would never reach anyone who had already loaded the page once.
//
// Keyed by SECTION, not by record — folding "Other income" folds it on every property.
// That's the right unit: it's a preference about a kind of section, not about Maple Plaza.
// Per-browser only; nothing is written to the account, so a second computer starts open.
const KEY = 'amlak.panels';

// Every read and write is guarded. Safari in private mode throws on localStorage, and a
// folded panel is not worth a white screen.
function readMap() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    // Anything that isn't a plain object of booleans is treated as absent rather than
    // trusted — a poisoned key must degrade to "every section at its default".
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function isPanelOpen(id, defaultOpen = true) {
  const map = readMap();
  return typeof map[id] === 'boolean' ? map[id] : defaultOpen;
}

export function setPanelOpenStored(id, open) {
  try {
    const map = readMap();
    map[id] = !!open;
    localStorage.setItem(KEY, JSON.stringify(map));
  } catch {
    /* ignore — the fold still works for this session */
  }
}

/**
 * Open state for one collapsible section, remembered across visits.
 * Returns [open, setOpen] where setOpen accepts a boolean or an updater.
 */
export function usePanelOpen(id, defaultOpen = true) {
  const [open, setOpen] = useState(() => (id ? isPanelOpen(id, defaultOpen) : defaultOpen));

  const set = useCallback((next) => {
    setOpen((cur) => {
      const val = typeof next === 'function' ? !!next(cur) : !!next;
      if (id) setPanelOpenStored(id, val);
      return val;
    });
  }, [id]);

  return [open, set];
}
