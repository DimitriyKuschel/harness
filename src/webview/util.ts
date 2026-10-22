import type { AgentId, AgentLimits, LimitWindow } from '../core/types';
import { t } from '../i18n';

/** Avatar initials. */
export const AGENT_SHORT: Record<AgentId, string> = { claude: 'Cl', codex: 'Cx', gemini: 'Gm' };

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

export function relativeTime(ts: number, now = Date.now()): string {
  const { time, dateLocale } = t();
  const diff = now - ts;
  if (diff < 60_000) return time.justNow;
  if (diff < 3_600_000) return time.minutesAgo(Math.floor(diff / 60_000));
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return time.yesterday;
  return d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' });
}

export function formatReset(unixSeconds?: number): string {
  if (!unixSeconds) return '';
  const { limits, dateLocale } = t();
  const d = new Date(unixSeconds * 1000);
  const time = d.toLocaleTimeString(dateLocale, { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === new Date().toDateString()) return limits.resetsAt(time);
  return limits.resetsOn(d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'short' }), time);
}

/** A window whose reset time has passed is effectively empty again. */
export function liveWindow(w?: LimitWindow | null): LimitWindow | undefined {
  if (!w) return undefined;
  if (w.resetsAt && w.resetsAt * 1000 < Date.now()) return { usedPercent: 0 };
  return w;
}

export function limitLevel(pct: number): 'ok' | 'warn' | 'high' {
  return pct >= 85 ? 'high' : pct >= 70 ? 'warn' : 'ok';
}

export function limitsTooltip(l?: AgentLimits): string {
  const { limits } = t();
  if (!l) return limits.notYet;
  const part = (name: string, w?: LimitWindow | null) => {
    if (w === null) return limits.noWindow(name);
    const live = liveWindow(w);
    if (!live) return limits.noData(name);
    const reset = live === w && w.resetsAt ? ` (${formatReset(w.resetsAt)})` : '';
    return `${limits.left(name, Math.round(100 - live.usedPercent))}${reset}`;
  };
  return [part(limits.fiveHours, l.fiveHour), part(limits.week, l.weekly), limits.updated(relativeTime(l.updatedAt))].join('\n');
}

const TOOL_ICONS: [RegExp, string][] = [
  [/^(read|view)/i, 'file'],
  [/(edit|write|patch|notebook)/i, 'edit'],
  [/(bash|shell|command|exec)/i, 'terminal'],
  [/(grep|glob|search|find)/i, 'search'],
  [/web/i, 'globe'],
  [/(task|agent)/i, 'person'],
  [/(todo|plan)/i, 'checklist'],
];

export function toolIcon(name: string): string {
  if (/websearch|webfetch/i.test(name)) return 'globe';
  return TOOL_ICONS.find(([re]) => re.test(name))?.[1] ?? 'tools';
}

export const isFileTool = (name: string) => /^(read|edit|write|multiedit|notebookedit)$/i.test(name);

export function cx(...names: (string | false | undefined | null)[]): string {
  return names.filter(Boolean).join(' ');
}
