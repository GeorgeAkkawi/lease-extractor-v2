// The drag itself. George, 2026-08-04: *"the drag feature for the sign needs to be more
// fluid."* It used to be tap → "Move it" → tap again; now the mark follows the finger, and
// these are the four things that separate a fluid drag from a janky one:
//
//   ① it lands where you let go, not where you grabbed
//   ② grabbing a mark you already placed keeps your grip point — it must NOT jump so its
//     middle snaps under your finger, which is what makes a drag feel like it's fighting you
//   ③ it can't be dragged off the page — the preview stops exactly where the stamp will
//   ④ a plain tap still places it, because that is what people do on a phone
//
// ⚠ pdf.js CANNOT RUN IN jsdom, so the renderer is mocked and the page is declared 600×800pt
// rendered at 600×800 CSS px — a deliberate 1:1 mapping, so every number below reads as both
// a pixel and a PDF point. The conversion maths itself is covered by signPlacement.test.js.
//
// ⚠ jsdom 25 HAS NO PointerEvent (checked, not assumed), so RTL's fireEvent.pointerDown would
// build a bare Event and clientX would arrive undefined. These fire a MouseEvent carrying the
// pointer event's NAME instead — React dispatches on the type string, so onPointerDown runs
// and the coordinates survive.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import PdfSignCanvas from '../PdfSignCanvas';

vi.mock('../../lib/pdfRender', () => ({
  openPdf: vi.fn(async () => ({ numPages: 2 })),
  renderPage: vi.fn(async () => ({ boxW: 600, boxH: 800, pageW: 600, pageH: 800, rotation: 0 })),
}));

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
// No image dimensions ever arrive (jsdom decodes nothing), so sigHeight falls back to w/3.
const W = 170;
const H = W / 3;

// A wrapper that behaves like the real callers: it keeps the placement it is handed.
function Harness({ initial = null, onPlace, disabled = false }) {
  const [placement, setPlacement] = useState(initial);
  return (
    <PdfSignCanvas
      url="data:application/pdf;base64,JVBERi0="
      signature={PNG}
      placement={placement}
      disabled={disabled}
      onPlace={(p) => { setPlacement(p); onPlace?.(p); }}
    />
  );
}

// Mount, wait for the page geometry to land, and hand back the pieces a drag needs.
async function mount(props = {}) {
  const spy = vi.fn();
  const { container } = render(<Harness onPlace={spy} {...props} />);
  const stage = container.querySelector('.pdfsign-stage');
  const canvas = container.querySelector('.pdfsign-canvas');
  // jsdom lays nothing out, so the page box has to be declared.
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 600, bottom: 800, width: 600, height: 800, x: 0, y: 0,
  });
  await waitFor(() => expect(stage.style.width).toBe('600px'));
  return { stage, canvas, container, spy };
}

const ptr = (el, type, clientX, clientY) =>
  fireEvent(el, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));

const drag = (el, from, to) => {
  ptr(el, 'pointerdown', from[0], from[1]);
  ptr(el, 'pointermove', to[0], to[1]);
  ptr(el, 'pointerup', to[0], to[1]);
};

beforeEach(cleanup);

describe('dragging the signature onto the line', () => {
  // ① Where you let go is where it goes.
  it('lands the mark where the drag ended', async () => {
    const { stage, spy } = await mount();
    drag(stage, [100, 100], [300, 500]);

    expect(spy).toHaveBeenCalledTimes(1);
    const p = spy.mock.calls[0][0];
    expect(p.page).toBe(1);
    expect(p.w).toBeCloseTo(W);
    // The drop point is the signature's CENTRE, and PDF y counts up from the bottom.
    expect(p.x).toBeCloseTo(300 - W / 2);
    expect(p.y).toBeCloseTo(800 - 500 - H / 2);
  });

  // ② The one that decides whether the drag feels fluid or fights you.
  it('keeps your grip point when you pick up a mark you already placed', async () => {
    const { stage, spy } = await mount({ initial: { page: 1, x: 100, y: 100, w: W } });
    // The placed box sits at CSS left 100, top 800-(100+H) = 643.33. Grab it 10px in and
    // 6.67px down from its own corner, then move exactly +100 right and 100 up the page.
    drag(stage, [110, 650], [210, 550]);

    const p = spy.mock.calls.at(-1)[0];
    expect(p.x).toBeCloseTo(200);   // not 210-85 = 125, which is what a re-centre would give
    expect(p.y).toBeCloseTo(200);
  });

  // ③ The preview must stop where the stamp stops, or the mark visibly jumps on release.
  it('will not let the mark be dragged off the page', async () => {
    const { stage, spy } = await mount();
    drag(stage, [300, 400], [-200, 5000]);

    const p = spy.mock.calls.at(-1)[0];
    expect(p.x).toBeCloseTo(4);   // EDGE in signPlacement.js
    expect(p.y).toBeCloseTo(4);
  });

  it('shows a ghost under the finger and hides the committed mark while it moves', async () => {
    const { stage, container } = await mount({ initial: { page: 1, x: 100, y: 100, w: W } });
    const ghost = container.querySelector('.pdfsign-ghost');
    expect(ghost.classList.contains('on')).toBe(false);

    ptr(stage, 'pointerdown', 110, 650);
    ptr(stage, 'pointermove', 210, 550);
    expect(ghost.classList.contains('on')).toBe(true);
    // Positioned by transform written straight to the element — no React render per move.
    expect(ghost.style.transform).toMatch(/^translate\(200px, 5[0-9.]+px\)$/);
    expect(container.querySelector('.pdfsign-placed.mine').style.visibility).toBe('hidden');

    ptr(stage, 'pointerup', 210, 550);
    expect(ghost.classList.contains('on')).toBe(false);
    expect(container.querySelector('.pdfsign-placed.mine').style.visibility).toBe('visible');
  });
});

describe('the tap that still has to work', () => {
  // ④ On a phone a tap is what people actually do, and it is also the path that survives
  // when pointer events never fire at all.
  it('places the mark on a plain tap', async () => {
    const { stage, spy } = await mount();
    fireEvent.click(stage, { clientX: 300, clientY: 500 });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0].x).toBeCloseTo(300 - W / 2);
  });

  it('does not re-place it when the tap lands on the mark itself', async () => {
    const { stage, spy } = await mount({ initial: { page: 1, x: 100, y: 100, w: W } });
    // Press and release without moving, on top of the existing mark, then the click the
    // browser fires afterwards. Holding your own signature is not a request to move it.
    ptr(stage, 'pointerdown', 110, 650);
    ptr(stage, 'pointerup', 110, 650);
    fireEvent.click(stage, { clientX: 110, clientY: 650 });
    expect(spy).not.toHaveBeenCalled();
  });

  it('a drag never also fires the tap — one gesture, one placement', async () => {
    const { stage, spy } = await mount();
    drag(stage, [100, 100], [300, 500]);
    fireEvent.click(stage, { clientX: 300, clientY: 500 });   // the browser's trailing click
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('ignores both while the signature is being submitted', async () => {
    const { stage, spy } = await mount({ disabled: true });
    drag(stage, [100, 100], [300, 500]);
    fireEvent.click(stage, { clientX: 300, clientY: 500 });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the prompt', () => {
  it('asks for a drag first and a tap second, and goes once placed', async () => {
    const { stage } = await mount();
    expect(screen.getByText(/Drag your signature onto the signature line/)).toBeTruthy();
    fireEvent.click(stage, { clientX: 300, clientY: 500 });
    await waitFor(() => expect(screen.queryByText(/Drag your signature onto the signature line/)).toBe(null));
    // …and the way back off the page is named for what it does, not for "move", which is
    // now the drag's job.
    expect(screen.getByRole('button', { name: 'Take it off' })).toBeTruthy();
  });
});
