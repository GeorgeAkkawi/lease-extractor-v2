// Small shared error line for mutation-bearing panels. Pass the mutations you want
// watched; if any has errored, it shows one friendly line so a failed click (save,
// delete, confirm) isn't silent. Renders nothing when everything is fine.
export default function MutationError({ of = [], message = "Couldn't save that change — please try again." }) {
  const failed = of.some((m) => m && m.isError);
  if (!failed) return null;
  return (
    <div className="note-msg" style={{ color: '#b42318', margin: '6px 0', fontSize: 12.5 }}>
      {message}
    </div>
  );
}
