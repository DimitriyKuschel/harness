// Runs that fail because a subscription's quota is spent. The CLIs' own quota reports can disagree with
// the server (agy's /usage showed 99% left while every Gemini run failed with "Individual quota reached"),
// so the error itself is the signal: the agent sits out until the reset the message names.
// Pure helpers (no Node APIs): the webview uses them too.
import type { AgentLimits } from './types';

/** When the error names no reset time. */
const QUOTA_BLOCK_S = 60 * 60;
/** A rate limit is short-lived. */
const RATE_BLOCK_S = 5 * 60;

const QUOTA =
  /quota[^.\n]{0,40}(?:reached|exceeded|exhausted)|resource[_ ]exhausted|usage[_ ]limit|hit your (?:usage )?limit|(?:5-hour|five[- ]hour|weekly|session|daily|monthly) limit reached|out of (?:credits|quota)|insufficient[_ ]quota|upgrade your (?:subscription|plan) to/i;
const RATE = /rate[_ ]?limit(?:ed)?(?:[^.\n]{0,20}(?:reached|exceeded))?|too many requests|\b429\b/i;

const UNITS: Record<string, number> = { d: 86_400, h: 3_600, m: 60, s: 1 };
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export interface QuotaHit {
  /** Unix seconds: when the agent may be asked again. */
  until: number;
  /** The reset came from the message, not a default guess. */
  known: boolean;
}

/** A spent-quota or rate-limit failure, and when it lifts. Undefined for any other error. */
export function quotaError(message: string | undefined, now = Date.now()): QuotaHit | undefined {
  if (!message) return undefined;
  const quota = QUOTA.test(message);
  if (!quota && !RATE.test(message)) return undefined;
  const reset = parseReset(message, new Date(now));
  if (reset && reset > now / 1000) return { until: reset, known: true };
  return { until: Math.floor(now / 1000) + (quota ? QUOTA_BLOCK_S : RATE_BLOCK_S), known: false };
}

/**
 * Reset times as the CLIs print them:
 * agy "Resets in 163h58m6s"; Codex "try again in 2 days 3 hours" / "try again at Oct 20th, 2026 3:04 PM";
 * Claude "resets 3pm (Europe/Berlin)" / "resets Oct 20, 3pm" / "usage limit reached|1761000000".
 */
export function parseReset(text: string, now: Date): number | undefined {
  const nowS = Math.floor(now.getTime() / 1000);

  const epoch = /\|(\d{10})\b/.exec(text);
  if (epoch) return Number(epoch[1]);

  const rel = /(?:resets?|try again|retry|available)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (rel) {
    let s = 0;
    for (const [, n, unit] of rel[1].matchAll(/(\d+)\s*([dhms])/gi)) s += Number(n) * UNITS[unit.toLowerCase()];
    if (s > 0) return nowS + s;
  }

  const at = /(?:try again|available)\s+at\s+(?:([a-z]{3})[a-z]*\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(?:(\d{4})\s+)?)?(\d{1,2}):(\d{2})\s*(am|pm)?/i.exec(text);
  if (at) return localTime(now, at[1], at[2], at[4], at[5], at[6], at[3]);

  const resets = /resets\s+(?:at\s+|on\s+)?(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (resets) return localTime(now, resets[1], resets[2], resets[3], resets[4], resets[5]);
  return undefined;
}

/** "Oct 18, 10:50pm" or "1pm" in the machine's time zone (the CLIs print local time) → unix seconds. */
export function localTime(now: Date, mon?: string, day?: string, hour?: string, min?: string, ampm?: string, year?: string): number | undefined {
  const month = mon ? MONTHS.indexOf(mon.toLowerCase()) : now.getMonth();
  if (month < 0 || hour === undefined) return undefined;
  let h = Number(hour);
  if (ampm) h = (h % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0);
  const d = new Date(year ? Number(year) : now.getFullYear(), month, day ? Number(day) : now.getDate(), h, Number(min ?? 0));
  // A bare time already past today means tomorrow; "Jan 2" seen in late December is next year.
  if (!day && d.getTime() < now.getTime()) d.setDate(d.getDate() + 1);
  else if (!year && d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return Math.floor(d.getTime() / 1000);
}

/** When an agent whose run hit the quota may work again (unix seconds); undefined if it may now. */
export function exhaustedUntil(l: AgentLimits | undefined, now = Date.now() / 1000): number | undefined {
  const until = l?.exhausted?.until;
  return until && until > now ? until : undefined;
}
