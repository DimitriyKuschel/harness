// Team plans: the lead answers in prose and ends with machine-readable blocks the orchestrator acts on:
// ```team-plan (tasks to execute) and, after an iteration, ```team-status (is the goal reached?).
// Pure helpers (no Node APIs): the webview uses stripPlanBlock too.
import { t } from '../i18n';
import { DOMAINS, TIERS, type AgentId, type Domain, type PlanTask, type TeamStatus, type Tier } from './types';

const FENCE = '```team-plan';
const STATUS_FENCE = '```team-status';
const MAX_TASKS = 8;

/** The lead's prose without the machine-readable blocks (also while they are still streaming). */
export function stripPlanBlock(text: string): string {
  const cuts = [text.indexOf(FENCE), text.indexOf(STATUS_FENCE)].filter((i) => i >= 0);
  return cuts.length ? text.slice(0, Math.min(...cuts)).trimEnd() : text;
}

/** The lead's verdict after an iteration. */
export function parseStatus(text: string): TeamStatus | undefined {
  const start = text.lastIndexOf(STATUS_FENCE);
  if (start < 0) return undefined;
  const body = text.slice(start + STATUS_FENCE.length);
  const end = body.indexOf('```');
  try {
    const raw = JSON.parse(end < 0 ? body : body.slice(0, end));
    if (!['done', 'continue', 'blocked'].includes(raw?.status)) return undefined;
    return { status: raw.status, reason: String(raw.reason ?? '').slice(0, 300) };
  } catch {
    return undefined;
  }
}

/**
 * Parses and sanitises the plan block. `assign` picks a replacement when the lead names an agent
 * that isn't available. Returns undefined when there is no usable block.
 */
export function parsePlan(text: string, assign: (domain: Domain, wanted?: string) => AgentId | undefined): PlanTask[] | undefined {
  const start = text.lastIndexOf(FENCE);
  if (start < 0) return undefined;
  const body = text.slice(start + FENCE.length);
  const end = body.indexOf('```');
  let raw: any;
  try {
    raw = JSON.parse(end < 0 ? body : body.slice(0, end));
  } catch {
    return undefined;
  }
  const list: any[] | undefined = Array.isArray(raw) ? raw : Array.isArray(raw?.tasks) ? raw.tasks : undefined;
  if (!list) return undefined;

  const tasks: PlanTask[] = [];
  const { taskTitle } = t();
  for (const [i, t] of list.slice(0, MAX_TASKS).entries()) {
    if (!t || typeof t !== 'object' || !String(t.task ?? '').trim()) continue;
    const domain: Domain = DOMAINS.includes(t.domain) ? t.domain : 'other';
    const agent = assign(domain, typeof t.agent === 'string' ? t.agent.toLowerCase() : undefined);
    if (!agent) continue;
    const id = typeof t.id === 'string' && t.id.trim() ? t.id.trim() : `t${i + 1}`;
    if (tasks.some((x) => x.id === id)) continue;
    tasks.push({
      id,
      title: String(t.title ?? '').trim().slice(0, 120) || taskTitle(i + 1),
      agent,
      domain,
      tier: TIERS.includes(t.tier) ? (t.tier as Tier) : 'standard',
      task: String(t.task).trim(),
      scope: typeof t.scope === 'string' && t.scope.trim() ? t.scope.trim().slice(0, 200) : undefined,
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
      status: 'pending',
    });
  }
  const ids = new Set(tasks.map((t) => t.id));
  for (const t of tasks) t.dependsOn = [...new Set(t.dependsOn)].filter((d) => d !== t.id && ids.has(d));
  return tasks;
}
