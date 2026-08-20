// SelectMenu replaces a <select>'s OS popup and keeps everything else about the element.
// These pin the four things that would silently rot:
//   1. the painted rows are READ from the same <option>/<optgroup> children the browser is
//      given — the whole anti-drift argument for not passing options twice;
//   2. picking commits through the native setter, so a call site's ordinary onChange fires;
//   3. focus never leaves the select (TaxCategorySelect/IncomeCategorySelect are handed an
//      onBlur that CLOSES the editor around them — a menu that took focus would close it
//      out from under the click that was choosing a value);
//   4. it portals to <body>, because .table-wrap's scroller clips anything positioned
//      inside the row.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import SelectMenu from '../SelectMenu';

function Harness({ onBlur, initial = 'b' }) {
  const [v, setV] = useState(initial);
  return (
    <div>
      <SelectMenu className="text-input" value={v} onBlur={onBlur} onChange={(e) => setV(e.target.value)}>
        <option value="">— pick —</option>
        <optgroup label="Letters">
          <option value="a">Alpha</option>
          <option value="b">Beta</option>
        </optgroup>
        {false && <optgroup label="Never"><option value="z">Zeta</option></optgroup>}
        <optgroup label="Numbers">
          {['1', '2'].map((n) => <option key={n} value={`n:${n}`}>Number {n}{n === '2' ? ' (last)' : ''}</option>)}
        </optgroup>
      </SelectMenu>
      <span data-testid="value">{v}</span>
    </div>
  );
}

const sel = () => document.querySelector('select');
const menu = () => document.querySelector('.sm-list');
const rows = () => Array.from(document.querySelectorAll('.sm-opt')).map((b) => b.textContent.replace('✓', ''));

beforeEach(() => cleanup());

describe('SelectMenu', () => {
  it('opens on mousedown and paints the select’s own options, groups and all', async () => {
    render(<Harness />);
    expect(menu()).toBe(null);
    fireEvent.mouseDown(sel());
    await waitFor(() => expect(menu()).toBeTruthy());

    // Read from the children, so the two lists cannot disagree. A `{false && …}` group
    // contributes nothing and a mapped array flattens — both are shapes real call sites use.
    expect(rows()).toEqual(['— pick —', 'Alpha', 'Beta', 'Number 1', 'Number 2 (last)']);
    expect(Array.from(document.querySelectorAll('.sm-group')).map((g) => g.textContent))
      .toEqual(['Letters', 'Numbers']);
    // An <option> whose children are an ARRAY still reads as the text the browser shows.
    expect(rows()).toContain('Number 2 (last)');
    // The current value is the marked row, and only that one.
    expect(document.querySelectorAll('.sm-opt.on')).toHaveLength(1);
    expect(document.querySelector('.sm-opt.on').textContent).toContain('Beta');
    // Portalled out of the row — .table-wrap is overflow-x:auto and would clip it (Tip.js).
    expect(menu().parentElement).toBe(document.body);
  });

  it('picking a row drives the ordinary onChange and closes the menu', async () => {
    render(<Harness />);
    fireEvent.mouseDown(sel());
    await waitFor(() => expect(menu()).toBeTruthy());

    const beta = Array.from(document.querySelectorAll('.sm-opt')).find((b) => b.textContent.includes('Number 1'));
    fireEvent.mouseDown(beta);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('n:1'));
    // The real element holds the value — it is still the control, not a decoration.
    expect(sel().value).toBe('n:1');
    expect(menu()).toBe(null);
  });

  it('never blurs the select, because the editors around it close on blur', async () => {
    let blurs = 0;
    render(<Harness onBlur={() => { blurs += 1; }} />);
    sel().focus();
    fireEvent.mouseDown(sel());
    await waitFor(() => expect(menu()).toBeTruthy());
    const alpha = Array.from(document.querySelectorAll('.sm-opt')).find((b) => b.textContent.includes('Alpha'));
    // mousedown with the default prevented is what keeps focus put — a plain click would
    // blur the select first and close the inline editor before the pick landed.
    fireEvent.mouseDown(alpha);
    await waitFor(() => expect(screen.getByTestId('value').textContent).toBe('a'));
    expect(document.activeElement).toBe(sel());
    expect(blurs).toBe(0);
  });

  it('Escape closes it and a second mousedown toggles it shut', async () => {
    render(<Harness />);
    fireEvent.mouseDown(sel());
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.keyDown(sel(), { key: 'Escape' });
    await waitFor(() => expect(menu()).toBe(null));

    fireEvent.mouseDown(sel());
    await waitFor(() => expect(menu()).toBeTruthy());
    fireEvent.mouseDown(sel());
    await waitFor(() => expect(menu()).toBe(null));
  });

  it('descends through a fragment — the shape a branched option list actually has', async () => {
    // StatementReview writes `{isIn ? (<>…</>) : (<>…</>)}`, so the select's ONLY child is a
    // Fragment. Not walking into it painted an empty menu over a fully populated select:
    // silent, unlogged, and invisible to a test that lists its options flat.
    const Branched = ({ out }) => (
      <SelectMenu className="text-input" value="x" onChange={() => {}}>
        {out ? (
          <>
            <option value="x">Expense</option>
            <optgroup label="Buckets"><option value="y">Landscaping</option></optgroup>
          </>
        ) : (
          <><option value="z">Deposit</option></>
        )}
      </SelectMenu>
    );
    render(<Branched out />);
    fireEvent.mouseDown(sel());
    await waitFor(() => expect(menu()).toBeTruthy());
    expect(rows()).toEqual(['Expense', 'Landscaping']);
    expect(Array.from(document.querySelectorAll('.sm-group')).map((g) => g.textContent)).toEqual(['Buckets']);
  });

  it('a disabled select never opens', async () => {
    render(
      <SelectMenu className="text-input" disabled value="a" onChange={() => {}}>
        <option value="a">Alpha</option>
      </SelectMenu>
    );
    fireEvent.mouseDown(sel());
    await new Promise((r) => setTimeout(r, 20));
    expect(menu()).toBe(null);
  });
});
