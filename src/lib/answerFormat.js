// Turn an AI answer into blocks the app can render.
//
// George, 2026-07-30: "There's a lot of noise and would be hard to read for somebody
// who didn't know what it was. Keep the detail. Remove the noise."
//
// The noise is markdown. Claude writes **bold**, "- " bullets, "1." lists and "> "
// quotes by default, nothing in this app has ever rendered them, and both answer
// surfaces (.qa-a, .ask-a-body) are white-space:pre-wrap — so every asterisk, hyphen
// and angle bracket has been printing as literal punctuation. The detail was always
// there; it was wearing its markup. Nothing here drops content: it only stops the
// markers from being read aloud.
//
// This is deliberately NOT a markdown parser, and takes no dependency. It handles the
// subset the models actually emit and leaves everything else as plain text, because a
// half-understood construct rendered wrong is worse than one rendered literally:
//
//   # headings   ·   - / * / • bullets   ·   1. numbered lists
//   > quoted clauses ("quote the relevant clause" is in the ask-lease prompt)
//   **bold**     ·   `code`
//
// Italics are deliberately unsupported. A lone `_` or `*` matches est_cam_annual and
// "3 * 4" far more often than it marks emphasis in an answer about a lease, and a
// wrongly-eaten underscore is a silent corruption of the figure it was part of.

// Split one line into text / bold / code runs. First match wins, single pass, so an
// unbalanced `**` simply stays literal rather than swallowing the rest of the answer.
export function inlineSpans(text) {
  const src = String(text ?? '');
  const spans = [];
  const re = /\*\*([\s\S]+?)\*\*|`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(src))) {
    if (m.index > last) spans.push({ t: 'text', v: src.slice(last, m.index) });
    if (m[1] != null) spans.push({ t: 'b', v: m[1] });
    else spans.push({ t: 'code', v: m[2] });
    last = re.lastIndex;
  }
  if (last < src.length) spans.push({ t: 'text', v: src.slice(last) });
  return spans;
}

// Blocks: { type:'p'|'h'|'quote', spans } | { type:'ul'|'ol', items: spans[] }
export function parseAnswer(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  const blocks = [];
  let para = [];
  let list = null;
  let quote = [];

  const pushPara = () => {
    const s = para.join(' ').trim();
    para = [];
    if (s) blocks.push({ type: 'p', spans: inlineSpans(s) });
  };
  const pushList = () => {
    if (list && list.items.length) {
      blocks.push({ type: list.type, items: list.items.map((i) => inlineSpans(i.trim())) });
    }
    list = null;
  };
  const pushQuote = () => {
    const s = quote.join(' ').trim();
    quote = [];
    if (s) blocks.push({ type: 'quote', spans: inlineSpans(s) });
  };
  const pushAll = () => { pushPara(); pushList(); pushQuote(); };

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    // A wrapped continuation is indented; a new block is not. That one bit is all the
    // indentation is used for — nested lists are flattened rather than half-supported.
    const indented = /^\s+\S/.test(raw);

    if (!line) { pushAll(); continue; }

    // A "---" rule carries no information in a four-sentence answer; it IS the noise.
    if (/^([-*_=])\1{2,}$/.test(line)) { pushAll(); continue; }

    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) { pushAll(); blocks.push({ type: 'h', spans: inlineSpans(h[1]) }); continue; }

    const q = line.match(/^>\s?(.*)$/);
    if (q) { pushPara(); pushList(); quote.push(q[1]); continue; }

    const ul = line.match(/^[-*•+]\s+(.+)$/);
    if (ul) {
      pushPara(); pushQuote();
      if (list && list.type !== 'ul') pushList();
      if (!list) list = { type: 'ul', items: [] };
      list.items.push(ul[1]);
      continue;
    }

    // Bounded to 3 digits so a line opening with a year ("2026. was the…") can't be
    // mistaken for a list marker.
    const ol = line.match(/^\d{1,3}[.)]\s+(.+)$/);
    if (ol) {
      pushPara(); pushQuote();
      if (list && list.type !== 'ol') pushList();
      if (!list) list = { type: 'ol', items: [] };
      list.items.push(ol[1]);
      continue;
    }

    if (list && indented) { list.items[list.items.length - 1] += ` ${line}`; continue; }
    if (quote.length && indented) { quote.push(line); continue; }

    pushList(); pushQuote(); para.push(line);
  }
  pushAll();
  return blocks;
}
