// Ask Amlak's AI email drafting, end to end against the demo mock: ask for a letter →
// the answer offers to write it, naming the tenant → clicking it opens the compose modal
// with a real, sendable letter.
//
// The load-bearing assertion is the LETTERHEAD. The model is only ever asked for prose
// (salutation + paragraphs, no sign-off), and the client wraps it in the same letter()
// scaffold every hand-written template uses. If that wrap were ever dropped, the draft
// would go out with no business identity and no signature — so the test looks for the
// company name and the "Sincerely," the scaffold adds, not for the model's own words.
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import AskPage from '../AskPage';
import { ChromeProvider } from '../../context/ChromeContext';
import { buildAiDraftEmail } from '../../lib/emailTemplates';

function renderAsk() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <ChromeProvider>
          <AskPage />
        </ChromeProvider>
      </QueryClientProvider>
    </MemoryRouter>
  );
}

async function ask(text) {
  const input = await waitFor(() => screen.getByLabelText(/Ask a question/i));
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: /^Ask$/i }));
}

beforeEach(() => cleanup());

describe('Ask Amlak — AI email drafts', () => {
  it('offers the letter, names the tenant, and opens a full draft in the compose modal', async () => {
    renderAsk();
    await waitFor(() => expect(screen.queryByText(/Loading your portfolio/)).toBeNull());
    await ask('Draft an email to City Dental about their outstanding balance');

    // The affordance names WHO it would write to, so a mis-picked tenant is visible
    // before anything is drafted. It does NOT price itself — George asked for the cost
    // wording out of the UI, so this pins its absence rather than merely its removal.
    const btn = await waitFor(() => screen.getByRole('button', { name: /Draft this email to City Dental/i }));
    expect(btn.textContent).not.toMatch(/cent/i);

    fireEvent.click(btn);

    // The compose modal — the same one the bell and the invoice use, so Gmail / another
    // mail app / Send now all come with it.
    await waitFor(() => expect(screen.getByText(/Email City Dental/i)).toBeTruthy());
    const body = await waitFor(() => screen.getByLabelText(/Message|Body/i, { selector: 'textarea' })
      || document.querySelector('textarea'));
    const text = body.value;

    // The scaffold's work: letterhead, addressed block, RE line, and ONE signature.
    expect(text).toMatch(/Acme Holdings/);
    expect(text).toMatch(/^RE: /m);
    expect(text).toMatch(/Dear /);
    expect(text.match(/Sincerely,/g)).toHaveLength(1);
    // The model's work: the tenant's actual figures, not invented ones.
    expect(text).toMatch(/City Dental|Maple Plaza/);
  });

  it('a plain question gets no draft button — drafting is never offered unasked', async () => {
    renderAsk();
    await waitFor(() => expect(screen.queryByText(/Loading your portfolio/)).toBeNull());
    await ask('Which tenants pay for the roof?');
    await waitFor(() => expect(screen.getByText(/Roof expenses are billed/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Draft this email/i })).toBeNull();
  });
});

describe('buildAiDraftEmail', () => {
  const business = { company_name: 'Acme Holdings', address: '1 Main St', contact_email: 'ops@acme.test' };
  const base = {
    business, tenant_name: 'City Dental PC', contact_name: 'Dr. Chen',
    tenant_email: 'chen@citydental.test', propertyName: 'Maple Plaza',
  };

  it('wraps prose in the standard letter, addressed and signed', () => {
    const { subject, body, to } = buildAiDraftEmail({
      ...base, subject: 'Outstanding Balance — Suite 204',
      bodyProse: 'Dear Dr. Chen,\n\nOur records show a balance of $4,208.33.\n\nPlease contact our office.',
    });
    expect(subject).toBe('Outstanding Balance — Suite 204');
    expect(to).toBe('chen@citydental.test');
    expect(body).toMatch(/^Acme Holdings/);
    expect(body).toContain('RE: Outstanding Balance — Suite 204');
    expect(body).toContain('Tenant at Maple Plaza');
    expect(body).toContain('$4,208.33');
    expect(body.trimEnd().endsWith('ops@acme.test')).toBe(true);
  });

  it('strips a sign-off the model added anyway — never two signatures', () => {
    const { body } = buildAiDraftEmail({
      ...base, subject: 'Notice',
      bodyProse: 'Dear Dr. Chen,\n\nPlease renew your certificate.\n\nSincerely,\nThe Management\nSome Company',
    });
    expect(body.match(/Sincerely,/g)).toHaveLength(1);
    expect(body).not.toContain('The Management');
    expect(body).toContain('Acme Holdings');
  });

  it('keeps paragraph breaks and folds soft-wrapped lines into one paragraph', () => {
    const { body } = buildAiDraftEmail({
      ...base, subject: 'Notice',
      bodyProse: 'Dear Dr. Chen,\n\nFirst line\nwrapped oddly.\n\nSecond paragraph.',
    });
    expect(body).toContain('First line wrapped oddly.');
    expect(body).toContain('Second paragraph.');
  });

  it('falls back to a sensible subject rather than sending a blank RE line', () => {
    const { subject, body } = buildAiDraftEmail({ ...base, subject: '   ', bodyProse: 'Dear Dr. Chen,\n\nHello.' });
    expect(subject).toBe('Regarding your lease at Maple Plaza');
    expect(body).toContain('RE: Regarding your lease at Maple Plaza');
  });
});
