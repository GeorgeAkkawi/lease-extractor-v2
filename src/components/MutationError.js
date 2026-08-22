// Small shared error line for mutation-bearing panels. Pass the mutations you want
// watched; if any has errored, it shows one line so a failed click (save, delete,
// confirm) isn't silent. Renders nothing when everything is fine.
//
// ⚠ THE REASON IS USUALLY THE POINT, AND IT USED TO BE THROWN AWAY. Several writes in this
// app refuse for a reason the app itself computed and can explain — a closed fiscal year, a
// split that would swallow the whole cheque, a figure that would take a month negative. Those
// arrive as a thrown Error carrying that sentence, and every one of them was replaced here by
// "Couldn't save that change — please try again". Retrying can never work: the refusal is
// permanent and explainable. So the thrown sentence is what shows, when it reads like a
// sentence; the friendly line stays for the crashes that don't say anything useful.
//
// A caller that passes `message` still wins — that is the panel saying it knows better.
const GENERIC = "Couldn't save that change — please try again.";

// Does this read like something written for a person? A PostgREST code, a bare status, or a
// wall of JSON is not an explanation, and printing it is worse than the friendly line.
function readable(detail) {
  const t = String(detail || '').trim();
  if (t.length < 8 || t.length > 240) return null;
  if (!/\s/.test(t)) return null;
  if (/PGRST|^\{|^\[|^[A-Z0-9_]{4,}$|^\d{3}$|violates row-level security|duplicate key value/i.test(t)) return null;
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export default function MutationError({ of = [], message }) {
  const failed = of.find((m) => m && m.isError);
  if (!failed) return null;
  const text = message || readable(failed.error?.message) || GENERIC;
  return (
    <div className="note-msg" style={{ color: '#b42318', margin: '6px 0', fontSize: 12.5 }}>
      {text}
    </div>
  );
}
