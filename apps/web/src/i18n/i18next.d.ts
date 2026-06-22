// Compile-time key checking + autocomplete for t(), with no codegen step.
// The ENGLISH catalogs are the source of truth for the key shape; every other
// locale (and the pseudo-locale) is validated against them. resolveJsonModule is
// already enabled in tsconfig.base.json, so `typeof <import>` types the JSON.
import 'i18next';
import type common from './locales/en/common.json';
import type settings from './locales/en/settings.json';
import type pages from './locales/en/pages.json';
import type phone from './locales/en/phone.json';

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof common;
      settings: typeof settings;
      pages: typeof pages;
      phone: typeof phone;
    };
  }
}
