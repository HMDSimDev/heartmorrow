import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import ICU from 'i18next-icu';
import LanguageDetector from 'i18next-browser-languagedetector';
import resourcesToBackend from 'i18next-resources-to-backend';
import { DEFAULT_LOCALE, PSEUDO_LOCALE, SUPPORTED_LOCALES, localeDir } from './locales';
import { pseudoize } from './pseudo';

// Namespaces map 1:1 onto app areas. Grow this as you extract more strings
// (e.g. 'pages', 'phone', 'minigames', 'gambling'); load each lazily where used.
export const NAMESPACES = ['common', 'settings', 'pages', 'phone'] as const;

// Vite statically analyzes this glob and emits ONE lazy chunk per locale file,
// so each language × namespace is code-split and fetched only when first needed.
const catalogs = import.meta.glob('./locales/**/*.json');

async function loadCatalog(locale: string, namespace: string): Promise<Record<string, unknown>> {
  const loader = catalogs[`./locales/${locale}/${namespace}.json`];
  if (!loader) return {};
  const mod = (await loader()) as { default: Record<string, unknown> };
  return mod.default;
}

const backend = resourcesToBackend(async (locale: string, namespace: string) => {
  // The pseudo-locale is derived from English so it always covers exactly what
  // has been extracted and never drifts out of date.
  if (locale === PSEUDO_LOCALE) return pseudoize(await loadCatalog(DEFAULT_LOCALE, namespace));
  return loadCatalog(locale, namespace);
});

// Keep <html lang>/<dir> in sync with the chosen UI language so assistive tech
// announces the right language and CSS direction follows. (app-context already
// uses documentElement for data-phase/season, so this is the established hook.)
function syncHtmlLang(locale: string): void {
  const el = document.documentElement;
  el.setAttribute('lang', locale);
  el.setAttribute('dir', localeDir(locale));
}

void i18n
  .use(ICU) // ICU MessageFormat: correct CLDR plurals + {date}/{number} formatting
  .use(LanguageDetector)
  .use(backend)
  .use(initReactI18next)
  .init({
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES.map((l) => l.code),
    nonExplicitSupportedLngs: false, // keep 'en-XA' distinct from 'en'
    ns: ['common'], // other namespaces load lazily on first useTranslation(ns)
    defaultNS: 'common',
    load: 'currentOnly',
    interpolation: { escapeValue: false }, // React already escapes output
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'dsim.locale', // mirrors dsim.theme / dsim.creatorMode
      caches: ['localStorage'],
    },
    react: { useSuspense: true },
    returnNull: false,
  });

i18n.on('languageChanged', syncHtmlLang);
i18n.on('initialized', () => syncHtmlLang(i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LOCALE));

export default i18n;
