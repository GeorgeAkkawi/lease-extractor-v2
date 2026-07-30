// The AI answers in markdown; nothing in the app ever rendered it, and both answer
// boxes were white-space:pre-wrap — so the asterisks, hyphens and angle brackets were
// printing as punctuation (George, 2026-07-30: "a lot of noise ... hard to read for
// somebody who didn't know what it was. Keep the detail. Remove the noise.")
//
// The load-bearing property is that NOTHING is lost: every one of these asserts the
// content survives, and only the markers go.
import { describe, it, expect } from 'vitest';
import { parseAnswer, inlineSpans } from '../answerFormat';

// Flatten a parsed answer back to plain text — the "nothing was dropped" check.
const flat = (blocks) =>
  blocks
    .map((b) => (b.items ? b.items.map((i) => i.map((s) => s.v).join('')).join(' ') : b.spans.map((s) => s.v).join('')))
    .join(' ');

describe('inlineSpans', () => {
  it('lifts **bold** out of the text without eating it', () => {
    const spans = inlineSpans('The rent is **$22,848** per year.');
    expect(spans.map((s) => s.t)).toEqual(['text', 'b', 'text']);
    expect(spans[1].v).toBe('$22,848');
    expect(spans.map((s) => s.v).join('')).toBe('The rent is $22,848 per year.');
  });

  it('leaves an unbalanced ** literal rather than swallowing the rest', () => {
    const spans = inlineSpans('Rent is **$22,848 per year.');
    expect(spans).toHaveLength(1);
    expect(spans[0].v).toBe('Rent is **$22,848 per year.');
  });

  it('never touches underscores or a lone asterisk', () => {
    // est_cam_annual and "3 * 4" are far more common in a lease answer than italics —
    // eating one silently corrupts a figure or a column name.
    const spans = inlineSpans('est_cam_annual is set, and 3 * 4 = 12.');
    expect(spans.map((s) => s.v).join('')).toBe('est_cam_annual is set, and 3 * 4 = 12.');
    expect(spans.every((s) => s.t === 'text')).toBe(true);
  });

  it('reads `code` spans', () => {
    const spans = inlineSpans('The `base_rent` column.');
    expect(spans[1]).toEqual({ t: 'code', v: 'base_rent' });
  });
});

describe('parseAnswer — a realistic Haiku answer', () => {
  const ANSWER = [
    '## Base Rent',
    '',
    'The annual base rent is **$22,848**, payable in monthly installments of $1,904.',
    '',
    'Key dates:',
    '- Commencement: **June 1, 2017**',
    '- Term: 120 months',
    '  with a renegotiation in year 8',
    '',
    'The lease states:',
    '',
    '> Base rent will increase annually by 2% and will be',
    '> renegotiated in the 8th year.',
  ].join('\n');

  const blocks = parseAnswer(ANSWER);

  it('turns the markers into structure', () => {
    expect(blocks.map((b) => b.type)).toEqual(['h', 'p', 'p', 'ul', 'p', 'quote']);
  });

  it('keeps every word — the detail survives, only the markup goes', () => {
    const text = flat(blocks);
    expect(text).toContain('$22,848');
    expect(text).toContain('June 1, 2017');
    expect(text).toContain('120 months');
    expect(text).toContain('renegotiated in the 8th year.');
    expect(text).not.toContain('**');
    expect(text).not.toContain('##');
    expect(text).not.toMatch(/(^|\s)>/);
  });

  it('folds a wrapped bullet continuation into its own item, not a new paragraph', () => {
    const ul = blocks.find((b) => b.type === 'ul');
    expect(ul.items).toHaveLength(2);
    expect(ul.items[1].map((s) => s.v).join('')).toBe('Term: 120 months with a renegotiation in year 8');
  });

  it('joins a wrapped quote into one block', () => {
    const q = blocks.find((b) => b.type === 'quote');
    expect(q.spans.map((s) => s.v).join('')).toBe(
      'Base rent will increase annually by 2% and will be renegotiated in the 8th year.'
    );
  });
});

describe('parseAnswer — lists and edges', () => {
  it('reads a numbered list as one ordered block', () => {
    const b = parseAnswer('1. First\n2. Second\n3. Third');
    expect(b).toHaveLength(1);
    expect(b[0].type).toBe('ol');
    expect(b[0].items).toHaveLength(3);
  });

  it('does not mistake a sentence opening with a year for a list item', () => {
    const b = parseAnswer('2026. was the year the term ends.');
    expect(b[0].type).toBe('p');
  });

  it('starts a new list when the marker style changes', () => {
    const b = parseAnswer('- one\n- two\n\n1. first\n2. second');
    expect(b.map((x) => x.type)).toEqual(['ul', 'ol']);
  });

  it('drops a --- rule, which carries nothing in a four-sentence answer', () => {
    const b = parseAnswer('Before.\n\n---\n\nAfter.');
    expect(b.map((x) => x.type)).toEqual(['p', 'p']);
    expect(flat(b)).toBe('Before. After.');
  });

  it('joins the lines of one paragraph, and splits on a blank line', () => {
    const b = parseAnswer('One line\nwrapped here.\n\nA second paragraph.');
    expect(b).toHaveLength(2);
    expect(b[0].spans.map((s) => s.v).join('')).toBe('One line wrapped here.');
  });

  it('handles plain prose with no markdown at all, unchanged', () => {
    const b = parseAnswer('The landlord maintains the roof.');
    expect(b).toEqual([{ type: 'p', spans: [{ t: 'text', v: 'The landlord maintains the roof.' }] }]);
  });

  it('returns nothing for empty, null and whitespace', () => {
    expect(parseAnswer('')).toEqual([]);
    expect(parseAnswer(null)).toEqual([]);
    expect(parseAnswer('   \n\n  ')).toEqual([]);
  });
});
