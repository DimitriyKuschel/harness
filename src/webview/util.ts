import type { AgentId, AgentLimits, LimitWindow } from '../core/types';

export const AGENT_META: Record<AgentId, { short: string; tagline: string }> = {
  claude: { short: 'Cl', tagline: 'архитектура, UI, тексты, планирование' },
  codex: { short: 'Cx', tagline: 'реализация кода, бэкенд, тесты, ревью' },
  gemini: { short: 'Gm', tagline: 'графика, мультимодальность, исследования' },
};

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return s % 60 ? `${m} мин ${s % 60} с` : `${m} мин`;
}

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  if (diff < 60_000) return 'только что';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} мин назад`;
  const d = new Date(ts);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const yesterday = new Date(now - 86_400_000);
  if (d.toDateString() === yesterday.toDateString()) return 'вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function formatReset(unixSeconds?: number): string {
  if (!unixSeconds) return '';
  const d = new Date(unixSeconds * 1000);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? `сброс в ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    : `сброс ${d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })}, ${d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
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
  if (!l) return 'Лимиты ещё не получены';
  const part = (name: string, w?: LimitWindow | null) => {
    if (w === null) return `${name}: у тарифа нет такого лимита`;
    const live = liveWindow(w);
    if (!live) return `${name}: нет данных`;
    const reset = live === w && w.resetsAt ? ` (${formatReset(w.resetsAt)})` : '';
    return `${name}: осталось ${Math.round(100 - live.usedPercent)}%${reset}`;
  };
  return [part('5 часов', l.fiveHour), part('Неделя', l.weekly), `Обновлено: ${relativeTime(l.updatedAt)}`].join('\n');
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
