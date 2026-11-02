'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { brand } from './brand';
import { ar } from './messages/ar';
import { en, type MessageKey, type Messages, type Plural } from './messages/en';
import { serverAr } from './messages/server-ar';
import { prefs, type Locale } from './prefs';

/**
 * Interface language. Each user picks English or Arabic in Settings; the choice
 * is kept per browser and sets the page's `lang` and `dir` (right-to-left for
 * Arabic). Pages are prerendered in English, so the saved language is applied
 * after hydration — `theme-init.js` already sets the direction before paint.
 *
 * Text written by the backend at run time (progress steps, process steps,
 * errors) arrives in English and is translated with `translateServer`, keyed by
 * the English sentence; anything not in the catalog shows as sent.
 */

export type { Locale, MessageKey };
export type Vars = Record<string, string | number>;

const CATALOG: Record<Locale, Messages> = { en, ar };

/** BCP 47 tag for Intl: Arabic as used in Saudi Arabia, with Western digits for SAP numbers, amounts and codes. */
export const INTL_LOCALE: Record<Locale, string> = { en: 'en', ar: 'ar-SA-u-nu-latn' };

// The current language for code outside React (formatting, the API client). Set by the provider.
let current: Locale = 'en';
export const getLocale = (): Locale => current;
export const intlLocale = (): string => INTL_LOCALE[current];

const fill = (text: string, vars?: Vars) => (vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text);

function pick(entry: string | Plural, locale: Locale, vars?: Vars): string {
  if (typeof entry === 'string') return entry;
  const n = Number(vars?.count ?? 0);
  const form = new Intl.PluralRules(INTL_LOCALE[locale]).select(n) as keyof Plural;
  return entry[form] ?? entry.other;
}

/** Translates a key in the given language; `{name}` placeholders are filled from `vars`, and `count` picks the plural form. */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  return fill(pick(CATALOG[locale][key] ?? en[key], locale, vars), vars);
}

/** A sentence the backend wrote in English, in the current language when the catalog has it. */
export function translateServer(text: string, locale: Locale = current): string {
  if (locale === 'en' || !text) return text;
  const exact = serverAr.exact[text] ?? serverAr.exact[text.replace(/\.$/, '')];
  if (exact) return exact;
  for (const [pattern, to] of serverAr.patterns) {
    const m = text.match(pattern);
    if (m) return to(...m.slice(1));
  }
  const tr = (part: string) => translateServer(part, locale);
  for (const [pattern, to] of serverAr.answers) {
    const m = text.match(pattern);
    if (m) return to(tr, ...m.slice(1));
  }
  return text;
}

export type T = (key: MessageKey, vars?: Vars) => string;

/** For keys built from a code (an SAP status, a risk class): whether the catalog has one. */
export const isMessageKey = (key: string): key is MessageKey => key in en;

interface I18n {
  locale: Locale;
  dir: 'ltr' | 'rtl';
  t: T;
  setLocale: (locale: Locale) => void;
}

const I18nContext = createContext<I18n>({ locale: 'en', dir: 'ltr', t: (k, v) => translate('en', k, v), setLocale: () => undefined });

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en');
  const apply = useCallback((next: Locale) => {
    current = next;
    document.documentElement.lang = next;
    document.documentElement.dir = next === 'ar' ? 'rtl' : 'ltr';
    setLocaleState(next);
  }, []);
  useEffect(() => apply(prefs.locale()), [apply]);
  const value = useMemo<I18n>(
    () => ({
      locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      t: (key, vars) => translate(locale, key, vars),
      setLocale: (next) => {
        prefs.setLocale(next);
        apply(next);
      },
    }),
    [locale, apply],
  );
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);

/**
 * The browser tab title in the interface language: "<page> — <product>", or the
 * product and its subtitle for the workspace. Pages are prerendered with the
 * English title; this replaces it once the language is known.
 */
export function useDocumentTitle(page?: MessageKey) {
  const { locale, t } = useContext(I18nContext);
  useEffect(() => {
    const subtitle = (locale === 'ar' && brand.i18n?.ar?.subtitle) || brand.subtitle;
    const wanted = page ? `${t(page)} — ${brand.name}` : `${brand.name} — ${subtitle}`;
    const apply = () => {
      if (document.title !== wanted) document.title = wanted;
    };
    apply();
    // Next.js writes the prerendered title again after hydration; keep ours.
    const watch = new MutationObserver(apply);
    watch.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => watch.disconnect();
  }, [locale, t, page]);
}
/** The translate function of the current language; components re-render when the language changes. */
export const useT = () => useContext(I18nContext).t;
