export type RichSeg = { kind: 'action' | 'text'; text: string };

/**
 * Split a date reply into inline segments for roleplay-style styling. Physical
 * actions / narration the model wraps in *asterisks* become `action` segments
 * (rendered as a quiet italic stage-direction, the same voice as a venue-flavor
 * aside); everything else is `text` — the character's normal speaking color.
 *
 * Asterisks are the ONLY delimiter we act on: they're unambiguous, and anything
 * inside an action span (including "quoted" words, e.g. *I think about "that"*) is
 * kept verbatim as part of the action, never re-scanned. That's deliberate — the
 * model quotes dialogue inconsistently, so we never key styling off quotes. Unmarked
 * text just stays normal, which means this degrades to today's plain output whenever
 * a reply contains no asterisks at all.
 *
 * `open` (streaming only): treat a trailing unbalanced "*…" as an open action, so
 * text turns italic the instant the * arrives rather than flickering plain→italic
 * when the closing * finally lands. Off for persisted text, where a lone * is a
 * genuine stray character and should render literally.
 */
export function parseRichLine(input: string, opts?: { open?: boolean }): RichSeg[] {
  // Collapse **double** / *** runs (a stray markdown-bold habit) to a single * so
  // they read as one clean action span instead of leaving orphan asterisks behind.
  const src = input.replace(/\*{2,}/g, '*');
  const segs: RichSeg[] = [];
  const action = /\*([^*\n]+?)\*/g; // balanced, single-line, non-greedy
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = action.exec(src))) {
    if (m.index > last) segs.push({ kind: 'text', text: src.slice(last, m.index) });
    segs.push({ kind: 'action', text: m[1] ?? '' });
    last = action.lastIndex;
  }
  const tail = src.slice(last);
  const openAt = opts?.open ? tail.indexOf('*') : -1;
  if (openAt === -1) {
    if (tail) segs.push({ kind: 'text', text: tail });
  } else {
    if (openAt > 0) segs.push({ kind: 'text', text: tail.slice(0, openAt) });
    const rest = tail.slice(openAt + 1);
    if (rest) segs.push({ kind: 'action', text: rest });
  }
  return segs;
}

/**
 * Render a reply string with *action* spans styled as italic stage-direction.
 * Purely presentational — the raw text (asterisks and all) is what's stored; this
 * only changes how it looks. The parent bubble keeps `white-space: pre-wrap`, so
 * the inline spans inherit newline/space handling unchanged.
 */
export function RichLine({ text, open }: { text: string; open?: boolean }) {
  const segs = parseRichLine(text, { open });
  return (
    <>
      {segs.map((s, i) =>
        s.kind === 'action' ? (
          <span key={i} className="date-rt-action">
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}
