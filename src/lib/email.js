// Client-side "send" helpers. We open the user's own Gmail compose window
// (or their default mail app) pre-filled — no backend, no scopes, no tokens.
// Encode each field ourselves so newlines survive as %0A and spaces don't turn
// into "+" inside the body.
const enc = (s) => encodeURIComponent(s == null ? '' : String(s));

// `from` selects which signed-in Google account opens the compose (authuser),
// so the user can send from whichever of their mailboxes they pick.
export function gmailComposeUrl({ from, to, subject, body }) {
  const auth = from ? `authuser=${enc(from)}&` : '';
  return `https://mail.google.com/mail/?${auth}view=cm&fs=1&to=${enc(to)}&su=${enc(subject)}&body=${enc(body)}`;
}

export function mailtoUrl({ to, subject, body }) {
  return `mailto:${enc(to)}?subject=${enc(subject)}&body=${enc(body)}`;
}

export function openCompose(url) {
  window.open(url, '_blank', 'noopener');
}
