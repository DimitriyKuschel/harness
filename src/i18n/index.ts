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

/** "resets at 21:05" today, "resets 1 Nov, 21:05" later. */
export function formatReset(unixSeconds?: number): string {
  if (!unixSeconds) return '';
  const { limits, dateLocale } = t();
  const d = new Date(unixSeconds * 1000);
  const time = d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return limits.resetsAt(time);
  return limits.resetsOn(d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' }), time);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return t().time.seconds(s);
  return t().time.minutes(Math.floor(s / 60), s % 60);
}
