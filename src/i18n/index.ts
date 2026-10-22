import { en, type Strings } from './en';
import { ru } from './ru';

export type Locale = 'en' | 'ru';
export type { Strings };

const STRINGS: Record<Locale, Strings> = { en, ru };
let current: Locale = 'en';

/** The host sets the language from `harness.language` / VS Code's display language; the webview gets it with each state. */
export function setLocale(l: Locale): void {
  current = l;
}

export function locale(): Locale {
  return current;
}

/** Strings in the current UI language. */
export function t(): Strings {
  return STRINGS[current];
}

/** `harness.language` → a supported locale; `auto` follows VS Code's display language. */
export function resolveLocale(setting: string | undefined, display: string): Locale {
  if (setting === 'en' || setting === 'ru') return setting;
  return display.toLowerCase().startsWith('ru') ? 'ru' : 'en';
}
