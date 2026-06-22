// The locales the UI can switch between. The i18n plumbing is locale-agnostic —
// add a real language by dropping `locales/<code>/<namespace>.json` files and a
// row here; nothing else needs to change.
//
// RTL note: the dir handling below is wired now, but the physical→logical CSS
// migration that real RTL rendering needs is a separate, tracked follow-up.

export type LocaleDir = 'ltr' | 'rtl';

export interface LocaleMeta {
  /** BCP-47 code, e.g. 'en', 'es', 'ar'. */
  code: string;
  /** Human label shown in the switcher (in its own language). */
  label: string;
  /** Optional explicit direction; otherwise inferred from the code. */
  dir?: LocaleDir;
}

export const DEFAULT_LOCALE = 'en';

/** QA-only pseudo-locale: accented + ~30% longer English, generated on the fly
 *  from the English catalogs (see pseudo.ts). Surfaces unextracted strings and
 *  layout/truncation bugs. Excluded from production builds. */
export const PSEUDO_LOCALE = 'en-XA';

export const SUPPORTED_LOCALES: LocaleMeta[] = [
  { code: 'en', label: 'English', dir: 'ltr' },
  // Add real locales here, e.g. { code: 'es', label: 'Español', dir: 'ltr' }.
  ...(import.meta.env.DEV ? [{ code: PSEUDO_LOCALE, label: 'Pseudo (QA)', dir: 'ltr' as const }] : []),
];

// Base languages that render right-to-left. New RTL locales inherit dir='rtl'
// automatically unless their row overrides it.
const RTL_BASES = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv']);

export function localeDir(code: string): LocaleDir {
  const meta = SUPPORTED_LOCALES.find((l) => l.code === code);
  if (meta?.dir) return meta.dir;
  const base = code.split('-')[0]?.toLowerCase() ?? '';
  return RTL_BASES.has(base) ? 'rtl' : 'ltr';
}
