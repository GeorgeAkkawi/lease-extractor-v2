// The four steps of putting a signature on a document, shown before the document itself.
//
// George, 2026-08-05: *"make the prompt for the signature signing and placing way more
// obvious right now its hidden theres needs to be clear instructions same thing for the
// contract signer after they input their signature. it has to be way more clear and
// straightforward for BOTH users that they sign and tap where they place the signature."*
//
// ⚠ ONE COMPONENT, BOTH SIDES — the tenant's or vendor's public signing page and the
// landlord's countersign dialog. The two screens are the same act seen from opposite ends,
// and the moment they explain it differently one of them is the one people get stuck on.
//
// The placing step is CONDITIONAL at the call site: a document pdf.js can't render has
// nowhere to tap, and promising a step that cannot happen is worse than not mentioning it.
export default function SignSteps({ steps }) {
  const current = steps.findIndex((s) => !s.done);
  return (
    <ol className="sign-steps">
      {steps.map((s, i) => (
        <li key={s.label} className={s.done ? 'done' : i === current ? 'now' : ''}>
          <span className="sign-step-n" aria-hidden="true">{s.done ? '✓' : i + 1}</span>
          <span>{s.label}</span>
        </li>
      ))}
    </ol>
  );
}
