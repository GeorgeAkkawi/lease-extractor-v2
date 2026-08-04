// Drives the REAL DocAssistant — the component behind the lease, policy and contract
// assistants — with an answer shaped the way Claude actually replies.
//
// A helper test on parseAnswer alone would have passed for the entire time the noise
// was on screen: the parser is new, but the bug was that nothing ever CALLED one. This
// asserts the markers reach the DOM as elements, and that the box no longer re-prints
// them as punctuation.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import DocAssistant from '../DocAssistant';

const MARKDOWN = [
  '## Base Rent',
  '',
  'The annual base rent is **$22,848**.',
  '',
  '- Monthly: $1,904',
  '- Commencement: June 1, 2017',
  '',
  '> Tenant shall pay Base Rent in equal monthly installments.',
].join('\n');

function mount(props = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DocAssistant
        label="lease"
        docText="ORIGINAL STORE LEASE — the cached copy."
        suggested={['What is the annual base rent?']}
        ask={async () => MARKDOWN}
        {...props}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => cleanup());

describe('Assistant answers — rendered, not printed', () => {
  it('turns the markdown into real elements and leaves no markers behind', async () => {
    const { container } = mount();
    fireEvent.click(screen.getByRole('button', { name: 'What is the annual base rent?' }));

    const ans = await waitFor(() => {
      const el = container.querySelector('.ans');
      expect(el).toBeTruthy();
      return el;
    });

    // Structure, not punctuation.
    expect(ans.querySelector('.ans-h').textContent).toBe('Base Rent');
    expect(ans.querySelector('strong').textContent).toBe('$22,848');
    expect([...ans.querySelectorAll('.ans-list li')].map((li) => li.textContent))
      .toEqual(['Monthly: $1,904', 'Commencement: June 1, 2017']);
    // The ask-lease prompt asks the model to quote the clause — it should look quoted.
    expect(ans.querySelector('.ans-q').textContent)
      .toBe('Tenant shall pay Base Rent in equal monthly installments.');

    // The detail is all still there…
    expect(ans.textContent).toContain('$22,848');
    expect(ans.textContent).toContain('June 1, 2017');
    // …and the noise is gone.
    expect(ans.textContent).not.toContain('**');
    expect(ans.textContent).not.toContain('##');
    expect(ans.textContent).not.toContain('- Monthly');
    expect(ans.textContent).not.toContain('> Tenant');
  });

  it('says one thing about what is on file, not three', async () => {
    // The panel heading and its intro paragraph both said "ask questions about the
    // lease"; this line used to say it a third time. It now reports state only.
    mount();
    expect(screen.getByText('A copy of this lease is saved.')).toBeTruthy();
    expect(screen.queryByText(/ask anything about it below/i)).toBeNull();
  });

  it('labels the suggested questions so the row explains itself', async () => {
    const { container } = mount();
    expect(container.querySelector('.qa-chips-label').textContent).toBe('Try asking');
    expect(container.querySelectorAll('button.qa-chip')).toHaveLength(1);
  });

  it('puts savedCopies above the Open row and documents below it, ask box last', async () => {
    // The two slots are the whole mechanism behind George's order (2026-08-04: "the
    // saved copy of the lease, then open lease, then open riders"). Pinned here at the
    // component level so the policy and contract assistants — which share this file and
    // pass neither slot — can't have it changed out from under them.
    const { container } = mount({
      savedCopies: <div data-testid="copies">saved copies</div>,
      documents: <div data-testid="docs">rider rows</div>,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Read text' }));
    await waitFor(() => expect(container.querySelector('.lease-doc')).toBeTruthy());

    const order = [...container.querySelectorAll('[data-testid="copies"], .doc-open-row, .lease-doc, [data-testid="docs"], .qa-form')]
      .map((el) => el.dataset.testid || (el.classList.contains('doc-open-row') ? 'open' : el.classList.contains('lease-doc') ? 'doc' : 'ask'));
    expect(order).toEqual(['copies', 'open', 'doc', 'docs', 'ask']);
  });

  it('leaves an assistant with no saved-copies list flush at the top', async () => {
    // The insurance policy and service-contract assistants pass no savedCopies, so their
    // Open row is the panel's first child. The rule that separates the lease's row from
    // its copies is positional (:not(:first-child) in App.css) precisely so it doesn't
    // draw a stray hairline straight under those panels' headings.
    const { container } = mount();
    const panel = container.querySelector('.doc-panel');
    expect(panel.firstElementChild.classList.contains('doc-open-row')).toBe(true);
  });
});
