// The coordinate maths behind drag-to-sign. This is the part that will look correct on every
// PDF anyone tests with and be wrong on a real scanned lease, so it is tested harder than
// anything around it — pdf.js can't render in jsdom, and if this module is right the rest is
// plumbing.
//
// Three systems, two of which disagree (see the header of signPlacement.js): the browser
// (top-left, y down, CSS px), pdf.js viewport space (bottom-left, points, /Rotate applied),
// and pdf-lib drawing space (bottom-left, points, /Rotate IGNORED).
import { describe, it, expect } from 'vitest';
import {
  dropToPdfPoint, pdfPointToBox, clampToPage, sigHeight, toUnrotated, hasPlacement,
  DEFAULT_SIG_WIDTH_PT,
} from '../signPlacement';

// US Letter, the shape of essentially every American commercial lease.
const PAGE = { pageW: 612, pageH: 792 };
// A rendered page in the browser at ~1.3× — deliberately NOT 1:1, so any place the code
// forgets to divide by the scale shows up.
const BOX = { boxW: 795.6, boxH: 1029.6 };

const near = (a, b, tol = 0.75) => expect(Math.abs(a - b)).toBeLessThanOrEqual(tol);

describe('sigHeight — never squash the signature', () => {
  it('keeps the image’s own aspect ratio', () => {
    expect(sigHeight(170, 400, 100)).toBeCloseTo(42.5); // 4:1 image
    expect(sigHeight(170, 300, 300)).toBeCloseTo(170);  // square
  });

  it('falls back to a 3:1 box rather than NaN when the image hasn’t decoded', () => {
    expect(sigHeight(170, 0, 0)).toBeCloseTo(170 / 3);
    expect(sigHeight(170, undefined, undefined)).toBeCloseTo(170 / 3);
    expect(Number.isFinite(sigHeight(undefined, undefined, undefined))).toBe(true);
  });
});

describe('dropToPdfPoint — browser drop → PDF points', () => {
  it('flips the y axis: dropping near the TOP gives a HIGH pdf y', () => {
    const top = dropToPdfPoint({ cssX: 400, cssY: 50, ...BOX, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    const bottom = dropToPdfPoint({ cssX: 400, cssY: 980, ...BOX, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    expect(top.y).toBeGreaterThan(bottom.y);
    // The browser's top of the page is the PDF's y ≈ 792.
    expect(top.y).toBeGreaterThan(700);
    expect(bottom.y).toBeLessThan(80);
  });

  it('treats the drop point as the signature’s CENTRE, not its corner', () => {
    // Someone dragging a chip aims its middle at the line.
    const p = dropToPdfPoint({ cssX: BOX.boxW / 2, cssY: BOX.boxH / 2, ...BOX, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    near(p.x + p.w / 2, 306);   // page centre x
    near(p.y + p.h / 2, 396);   // page centre y
  });

  it('divides out the render scale — the SAME drop at a different zoom lands identically', () => {
    const atSmall = dropToPdfPoint({ cssX: 300, cssY: 400, boxW: 612, boxH: 792, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    // Same relative position on a box rendered twice as large.
    const atLarge = dropToPdfPoint({ cssX: 600, cssY: 800, boxW: 1224, boxH: 1584, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    near(atSmall.x, atLarge.x);
    near(atSmall.y, atLarge.y);
  });

  it('a phone-width render and a desktop render agree', () => {
    // The whole reason placement is stored in points and not pixels.
    const phone = dropToPdfPoint({ cssX: 180, cssY: 466, boxW: 360, boxH: 466, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    const desk = dropToPdfPoint({ cssX: 500, cssY: 1294, boxW: 1000, boxH: 1294, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    near(phone.x, desk.x);
    near(phone.y, desk.y);
  });
});

describe('clampToPage — the whole box stays on the page, not just its corner', () => {
  it('pulls a signature dropped off the right edge back on', () => {
    const p = dropToPdfPoint({ cssX: BOX.boxW + 200, cssY: 500, ...BOX, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    expect(p.x + p.w).toBeLessThanOrEqual(612);
    expect(p.x).toBeGreaterThanOrEqual(0);
  });

  it('pulls one dropped below the bottom edge back on — signature lines live down there', () => {
    const p = dropToPdfPoint({ cssX: 400, cssY: BOX.boxH + 300, ...BOX, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y + p.h).toBeLessThanOrEqual(792);
  });

  it('a box bigger than the page pins to the bottom-left instead of flying off the far edge', () => {
    const p = clampToPage({ x: 500, y: 700, w: 900, h: 900 }, 612, 792);
    expect(p.x).toBeLessThanOrEqual(612);
    expect(p.y).toBeLessThanOrEqual(792);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
});

describe('pdfPointToBox — the exact inverse, so the countersign screen shows it where it is', () => {
  it('round-trips a drop back to the same place on screen', () => {
    const drop = { cssX: 430, cssY: 870 };
    const pt = dropToPdfPoint({ ...drop, ...BOX, ...PAGE, width: 170, imgW: 400, imgH: 100 });
    const box = pdfPointToBox({ ...pt, ...PAGE, ...BOX });
    // Back to the CENTRE we dropped on.
    near(box.left + box.width / 2, drop.cssX, 1.5);
    near(box.top + box.height / 2, drop.cssY, 1.5);
  });

  it('measures `top` from the TOP of the signature, not its baseline', () => {
    // y is the box's BOTTOM in PDF space; on screen the top edge is height above it.
    const box = pdfPointToBox({ x: 100, y: 100, w: 170, h: 42.5, ...PAGE, boxW: 612, boxH: 792 });
    near(box.top, 792 - 100 - 42.5);
  });
});

// ── The bridge that only matters on scanned leases ──────────────────────────────────────
describe('toUnrotated — pdf.js applies /Rotate, pdf-lib does not', () => {
  it('is a no-op on an unrotated page (the common case stays exactly as it was)', () => {
    const p = toUnrotated({ x: 100, y: 200, w: 170, h: 42 }, 0, 612, 792);
    expect(p).toEqual({ x: 100, y: 200, w: 170, h: 42, angle: 0 });
  });

  it('inverts both axes at 180° and draws the mark upside-down', () => {
    const p = toUnrotated({ x: 100, y: 200, w: 170, h: 42 }, 180, 612, 792);
    expect(p.x).toBeCloseTo(612 - 100 - 170);
    expect(p.y).toBeCloseTo(792 - 200 - 42);
    expect(p.angle).toBe(180);
  });

  it('rotates the drawn image at 90° and 270° so it reads the right way up', () => {
    expect(toUnrotated({ x: 10, y: 20, w: 170, h: 42 }, 90, 612, 792).angle).toBe(90);
    expect(toUnrotated({ x: 10, y: 20, w: 170, h: 42 }, 270, 612, 792).angle).toBe(270);
  });

  it('normalises a negative or over-turned rotation instead of falling through', () => {
    // /Rotate -90 and /Rotate 450 both mean 270 and 90. A raw modulo would give -90.
    expect(toUnrotated({ x: 10, y: 20, w: 170, h: 42 }, -90, 612, 792).angle).toBe(270);
    expect(toUnrotated({ x: 10, y: 20, w: 170, h: 42 }, 450, 612, 792).angle).toBe(90);
    expect(toUnrotated({ x: 10, y: 20, w: 170, h: 42 }, 360, 612, 792).angle).toBe(0);
  });

  it('keeps every rotation’s result ON the page', () => {
    [0, 90, 180, 270].forEach((r) => {
      const p = toUnrotated({ x: 120, y: 90, w: 170, h: 42 }, r, 612, 792);
      expect(p.x).toBeGreaterThanOrEqual(-1);
      expect(p.y).toBeGreaterThanOrEqual(-1);
      expect(p.x).toBeLessThanOrEqual(613);
      expect(p.y).toBeLessThanOrEqual(793);
    });
  });
});

describe('hasPlacement — a half-written row must NOT stamp', () => {
  const full = { place_page: 3, place_x: 100, place_y: 200, place_w: 170 };

  it('accepts a complete placement', () => {
    expect(hasPlacement(full)).toBe(true);
  });

  it('rejects every partial one', () => {
    // Each of these would otherwise stamp at 0,0 — a signature in the corner of page 1 of
    // somebody's lease, which is worse than not stamping at all.
    expect(hasPlacement({ ...full, place_x: null })).toBe(false);
    expect(hasPlacement({ ...full, place_y: undefined })).toBe(false);
    expect(hasPlacement({ ...full, place_w: 0 })).toBe(false);
    expect(hasPlacement({ ...full, place_page: 0 })).toBe(false);
    expect(hasPlacement({ ...full, place_page: null })).toBe(false);
    expect(hasPlacement(null)).toBe(false);
    expect(hasPlacement({})).toBe(false);
  });

  it('a signer who simply never dragged anything is not placed — and that is fine', () => {
    expect(hasPlacement({ name: 'Sam', signed_at: '2026-08-04' })).toBe(false);
  });
});

describe('the default width is sane for a real signature line', () => {
  it('is under half the width of a Letter page', () => {
    expect(DEFAULT_SIG_WIDTH_PT).toBeLessThan(612 / 2);
    expect(DEFAULT_SIG_WIDTH_PT).toBeGreaterThan(100);
  });
});
