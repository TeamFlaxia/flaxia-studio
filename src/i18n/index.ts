import type { EnResource } from './en.ts';
import { en } from './en.ts';
import { ja } from './ja.ts';

/** Locales known to the registry. Add new ones to `locales` below. */
export type Locale = 'en' | 'ja';

type FlatResource = Readonly<Record<string, string>>;

/* -------------------------------------------------------------------------- */
/* Type-level helpers: keys and placeholders come from the English resource.  */
/* -------------------------------------------------------------------------- */

type Join<P extends string, K extends string> = P extends '' ? K : `${P}.${K}`;

type LeafPaths<T, P extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? Join<P, K> : LeafPaths<T[K], Join<P, K>>;
}[keyof T & string];

type ValueAt<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T
    ? ValueAt<T[Head], Rest>
    : never
  : P extends keyof T
    ? T[P]
    : never;

type Placeholders<S extends string> = S extends `${string}{${infer Name}}${infer Rest}`
  ? Name | Placeholders<Rest>
  : never;

/** Every valid dotted key, e.g. `publish.title`. Unknown keys fail typecheck. */
export type ResourceKey = LeafPaths<EnResource>;

/** Required placeholder names for a given key (empty when it has none). */
export type TranslateParams<K extends ResourceKey> = [
  Placeholders<Extract<ValueAt<EnResource, K>, string>>,
] extends [never]
  ? Record<string, never>
  : {
      readonly [P in Placeholders<Extract<ValueAt<EnResource, K>, string>>]: string | number;
    };

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

function flattenTree(node: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (!node || typeof node !== 'object') return out;
  for (const [key, value] of Object.entries(node)) {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    if (typeof value === 'string') out[path] = value;
    else flattenTree(value, path, out);
  }
  return out;
}

/** Frozen locale registry. `en` is authoritative; `ja` is a scaffold for now. */
export const locales: Readonly<Record<Locale, FlatResource>> = Object.freeze({
  en: Object.freeze(flattenTree(en)),
  ja: Object.freeze(flattenTree(ja)),
});

/** Type guard for narrowing an arbitrary string to a registered locale. */
export function isLocale(locale: string): locale is Locale {
  return Object.hasOwn(locales, locale);
}

let currentLocale: Locale = 'en';

/**
 * Switch the active locale. Unknown values fall back to `en`, so a stale or
 * unsupported browser setting can never break translation lookups.
 * Returns the locale actually selected.
 */
export function setLocale(locale: string): Locale {
  currentLocale = isLocale(locale) ? locale : 'en';
  return currentLocale;
}

/** The effective (always registered) locale. */
export function getLocale(): Locale {
  return currentLocale;
}

/* -------------------------------------------------------------------------- */
/* Translation                                                                */
/* -------------------------------------------------------------------------- */

const PLACEHOLDER = /\{([^{}]+)\}/g;

function interpolate(
  template: string,
  params: Readonly<Record<string, string | number>> | undefined,
): string {
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * Translate a key in the active locale.
 *
 * - Keys are derived from `en.ts`, so typos are compile-time errors.
 * - `{name}` placeholders are replaced from `params`.
 * - Missing keys fall back to English, then to the key string itself (a
 *   safety net for untyped callers). No external dependency, no DOM access.
 */
export function t<K extends ResourceKey>(key: K, params?: TranslateParams<K>): string {
  const resource = locales[currentLocale] ?? locales.en;
  const template = resource[key] ?? locales.en[key] ?? key;
  return interpolate(template, params as Readonly<Record<string, string | number>> | undefined);
}
