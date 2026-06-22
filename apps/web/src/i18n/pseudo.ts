// Pseudo-localization for QA. Turns English source strings into accented text
// that is ~30% longer and bracket-wrapped, WITHOUT touching interpolation
// placeholders ({{var}}, ICU {count, ...}) or <Trans> tags — so real bugs pop:
//   • a still-plain-English string on screen = an unextracted hardcoded literal.
//   • text clipped by ⟦…⟧ brackets = a layout that won't survive longer languages.
// Generated from the English catalogs at load time, so it never goes stale.

const MAP: Record<string, string> = {
  a: 'á', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ǧ', h: 'ħ', i: 'í', j: 'ĵ',
  k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ó', p: 'þ', q: 'ʠ', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'ú', v: 'ѵ', w: 'ŵ', x: 'х', y: 'ý', z: 'ž',
  A: 'Á', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ǧ', H: 'Ħ', I: 'Í', J: 'Ĵ',
  K: 'Ķ', L: 'Ļ', M: 'Ϻ', N: 'Ñ', O: 'Ó', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ',
  U: 'Ú', V: 'Ѵ', W: 'Ŵ', X: 'Х', Y: 'Ý', Z: 'Ž',
};

function transform(text: string): string {
  let out = '';
  let braceDepth = 0; // inside { ... } — covers both ICU {x} and i18next {{x}}
  let inTag = false; // inside < ... > — <Trans> element placeholders
  let letters = 0;
  for (const ch of text) {
    if (ch === '{') { braceDepth++; out += ch; continue; }
    if (ch === '}') { braceDepth = Math.max(0, braceDepth - 1); out += ch; continue; }
    if (braceDepth > 0) { out += ch; continue; }
    if (ch === '<') { inTag = true; out += ch; continue; }
    if (ch === '>') { inTag = false; out += ch; continue; }
    if (inTag) { out += ch; continue; }
    const mapped = MAP[ch];
    if (mapped) { letters++; out += mapped; } else { out += ch; }
  }
  const pad = letters > 0 ? ' ' + '·'.repeat(Math.ceil(letters * 0.3)) : '';
  return `⟦${out}${pad}⟧`;
}

/** Deep-pseudoize a catalog: transforms string leaves, preserves keys/structure. */
export function pseudoize<T>(input: T): T {
  if (typeof input === 'string') return transform(input) as unknown as T;
  if (Array.isArray(input)) return input.map((v) => pseudoize(v)) as unknown as T;
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = pseudoize(v);
    return out as unknown as T;
  }
  return input;
}
