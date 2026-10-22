import { t } from '../i18n';
import { prompts } from './prompts';
import {
  AGENT_LABELS,
  DOMAINS,
  TIERS,
  type AgentAdapter,
  type AgentId,
  type AgentLimits,
  type Autonomy,
  type Domain,
  type LimitWindow,
  type ModelChoice,
  type Profile,
  type RouteInfo,
  type Tier,
} from './types';

export interface RouterConfig {
  classifier: 'llm' | 'heuristic';
  affinity: Partial<Record<Domain, AgentId[]>>;
  models: Partial<Record<AgentId, Partial<Record<Tier, ModelChoice>>>>;
  strengths: Partial<Record<AgentId, string>>;
}

export interface RouteContext {
  /** Installed and enabled agents. */
  available: AgentId[];
  limits: Partial<Record<AgentId, AgentLimits>>;
  busy: ReadonlySet<AgentId>;
  profile: Profile;
  autonomy: Autonomy;
  /** A few recent messages, so "да, сделай" can be judged in context. */
  recent: string;
  cwd: string;
}

export interface Assessment {
  tier: Tier;
  domain: Domain;
  needsChanges: boolean;
  /** Big enough to split between specialists, or the CEO asked to divide the work. */
  team?: boolean;
  reason: string;
  via: 'llm' | 'heuristic';
}

const CLASSIFIER_SCHEMA = {
  type: 'object',
  properties: {
    tier: { type: 'string', enum: [...TIERS] },
    domain: { type: 'string', enum: [...DOMAINS] },
    needsChanges: { type: 'boolean' },
    team: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['tier', 'domain', 'needsChanges', 'team', 'reason'],
  additionalProperties: false,
};

/** Agents above this share of any quota window are skipped when others are available. */
const EXHAUSTED = 97;

export class Router {
  constructor(
    private readonly config: () => RouterConfig,
    private readonly adapters: Record<AgentId, AgentAdapter>,
    private readonly scratchDir: () => string,
  ) {}

  /** Full routing for a message without an explicit @mention. */
  async route(text: string, ctx: RouteContext, signal: AbortSignal): Promise<{ route: RouteInfo; team: boolean }> {
    const a = await this.assess(text, ctx, signal);
    const agent = this.pickAgent(a, ctx);
    if (!agent) throw new Error(t().notices.routerNoAgents);
    return { route: this.finish(agent, a, ctx, a.via), team: !!a.team && ctx.available.length >= 2 };
  }

  /**
   * Routing when the CEO named the agent: only tier/effort is decided, heuristically. A short follow-up
   * resumes the agent's session, so it keeps at least `floor`, the tier the agent last worked at.
   */
  forAgent(agent: AgentId, text: string, ctx: RouteContext, tierOverride?: Tier, floor?: Tier): RouteInfo {
    const a = heuristicAssessment(text);
    if (tierOverride) return this.finish(agent, { ...a, tier: tierOverride, reason: t().reasons.manual }, ctx, 'mention', true);
    const tier = shiftTier(a.tier, ctx.profile);
    if (floor && !isSmallTalk(text) && TIERS.indexOf(floor) > TIERS.indexOf(tier)) {
      return this.finish(agent, { ...a, tier: floor, reason: t().reasons.continued }, ctx, 'mention', true);
    }
    return this.finish(agent, { ...a, tier, reason: t().reasons.mention }, ctx, 'mention', true);
  }

  finish(agent: AgentId, a: Assessment, ctx: RouteContext, via: RouteInfo['via'], exactTier = false): RouteInfo {
    const tier = exactTier ? a.tier : shiftTier(a.tier, ctx.profile);
    const choice = this.modelFor(agent, tier);
    return { agent, model: choice.model, effort: choice.effort, tier, domain: a.domain, autonomy: ctx.autonomy, reason: a.reason, via };
  }

  modelFor(agent: AgentId, tier: Tier): ModelChoice {
    const table = this.config().models[agent] ?? {};
    const found = table[tier] ?? table.standard;
    return { model: found?.model || undefined, effort: found?.effort ?? 'medium' };
  }

  /**
   * Lowest score wins: domain affinity, spent quota, current load. The classifier only describes the
   * task — it runs on one vendor's model and would favour its own vendor if it picked the agent.
   */
  pickAgent(a: Pick<Assessment, 'domain'>, ctx: Pick<RouteContext, 'available' | 'limits' | 'busy'>, exclude: AgentId[] = []): AgentId | undefined {
    const candidates = ctx.available.filter((id) => !exclude.includes(id));
    if (!candidates.length) return undefined;
    const order = this.config().affinity[a.domain] ?? this.config().affinity.other ?? [];
    const score = (id: AgentId) => {
      const rank = order.indexOf(id);
      let s = rank < 0 ? order.length : rank;
      s += quotaPenalty(ctx.limits[id]);
      if (ctx.busy.has(id)) s += 0.3;
      return s;
    };
    return [...candidates].sort((x, y) => score(x) - score(y))[0];
  }

  async assess(text: string, ctx: RouteContext, signal: AbortSignal): Promise<Assessment> {
    const heuristic = heuristicAssessment(text);
    if (this.config().classifier !== 'llm' || isSmallTalk(text)) return heuristic;

    const runner = this.classifierAgent(ctx);
    if (!runner) return heuristic;
    try {
      const { model, effort } = this.modelFor(runner, 'trivial');
      const out = await this.adapters[runner].run(
        {
          prompt: this.classifierPrompt(text, ctx),
          cwd: this.scratchDir(),
          model,
          effort,
          autonomy: 'readonly',
          ephemeral: true,
          jsonSchema: CLASSIFIER_SCHEMA,
        },
        () => {},
        signal,
      );
      const r = out.structured as Partial<Assessment> | undefined;
      if (!out.ok || !r || !TIERS.includes(r.tier as Tier) || !DOMAINS.includes(r.domain as Domain)) return heuristic;
      return {
        // The CEO calling the task critical outranks the classifier's "don't overrate" bias.
        tier: heuristic.tier === 'critical' ? 'critical' : (r.tier as Tier),
        domain: r.domain as Domain,
        needsChanges: !!r.needsChanges,
        team: !!r.team || heuristic.team,
        reason: String(r.reason ?? '').slice(0, 160),
        via: 'llm',
      };
    } catch {
      return heuristic;
    }
  }

  /** Team roster for the lead's planning prompt: strengths and spent quota. */
  roster(ctx: Pick<RouteContext, 'available' | 'limits'>): string {
    const strengths = this.strengths();
    return ctx.available
      .map((id) => prompts().rosterLine(AGENT_LABELS[id], id, strengths[id], Math.round(effectiveUsage(ctx.limits[id]))))
      .join('\n');
  }

  /** `harness.strengths` over the built-in descriptions in the UI language. */
  private strengths(): Record<AgentId, string> {
    return { ...prompts().strengths, ...this.config().strengths };
  }

  /** The cheapest healthy agent runs the classifier. */
  private classifierAgent(ctx: RouteContext): AgentId | undefined {
    const preference: AgentId[] = ['claude', 'codex', 'gemini'];
    return preference.find((id) => ctx.available.includes(id) && quotaPenalty(ctx.limits[id]) < 3);
  }

  private classifierPrompt(text: string, ctx: RouteContext): string {
    const strengths = this.strengths();
    const team = ctx.available.map((id) => `- ${id} (${AGENT_LABELS[id]}): ${strengths[id]}`).join('\n');
    return prompts().classifier(team, ctx.recent, text.slice(0, 6000));
  }
}

export function shiftTier(tier: Tier, profile: Profile): Tier {
  const i = TIERS.indexOf(tier);
  if (profile === 'eco') return TIERS[Math.max(0, i - 1)];
  if (profile === 'max') return TIERS[Math.min(TIERS.length - 1, i + 1)];
  return tier;
}

export function bumpTier(tier: Tier): Tier {
  return TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(tier) + 1)];
}

/** Highest current utilisation across windows, ignoring windows that already reset. */
export function effectiveUsage(l: AgentLimits | undefined, now = Date.now() / 1000): number {
  if (!l) return 0;
  const live = (w?: LimitWindow | null) => (w && !(w.resetsAt && w.resetsAt < now) ? w.usedPercent : 0);
  return Math.max(live(l.fiveHour), live(l.weekly));
}

/**
 * Every subscription is paid for, so spent quota steadily shifts work to colleagues:
 * 60% more usage outweighs one step of domain affinity. Near the cap an agent is avoided.
 */
export function quotaPenalty(l: AgentLimits | undefined): number {
  const u = effectiveUsage(l);
  let p = u / 60;
  if (u >= EXHAUSTED) p += 100;
  else if (u >= 85) p += 3;
  return p;
}

// ---- Heuristics ----

const rx = (words: string[]) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${words.join('|')})`, 'iu');

const CHANGE = rx([
  'сделай', 'добавь', 'исправь', 'почини', 'реализуй', 'напиши', 'создай', 'удали', 'переименуй', 'обнови', 'отрефактор',
  'внедри', 'настрой', 'перепиши', 'сгенерируй', 'подключи', 'implement', 'add', 'fix', 'create', 'write', 'refactor',
  'update', 'remove', 'rename', 'build', 'generate', 'make', 'change', 'delete', 'edit', 'rewrite', 'replace', 'configure',
  'set up', 'install', 'integrate', 'convert',
]);
const HARD = rx([
  'архитектур', 'спроектир', 'рефактор', 'миграц', 'оптимизир', 'безопасн', 'уязвим', 'производительн', 'масштабир',
  'с нуля', 'весь проект', 'всего проекта', 'race', 'concurren', 'architect', 'security', 'performance', 'migrat',
  'refactor', 'optimi', 'vulnerab', 'scalab', 'from scratch', 'whole project', 'entire project', 'whole codebase', 'entire codebase',
]);
// "не критично" / "not critical" says the opposite.
const CRITICAL = /(?<![\p{L}\p{N}])(?<!(?:не|not)\s+)(?:критич|critical)/iu;
const TEAM = rx([
  'распредели', 'распределите', 'раздай', 'раздайте', 'всей командой', 'кто за что', 'по ролям', 'split the work', 'split up the work',
  'divide the work', 'distribute the work', 'whole team', 'entire team', 'among yourselves', 'between yourselves', 'who does what',
]);
const SMALL_TALK = rx([
  'привет', 'спасибо', 'ок', 'окей', 'понял', 'супер', 'отлично', 'ясно', 'hi', 'hello', 'hey', 'thanks', 'thank you', 'thx', 'ok',
  'got it', 'understood', 'great', 'awesome', 'perfect', 'cool',
]);

const DOMAIN_WORDS: [Domain, RegExp][] = [
  ['design', rx([
    'дизайн', 'график', 'иконк', 'логотип', 'изображен', 'картинк', 'иллюстрац', 'баннер', '3d', 'blender', 'svg', 'figma', 'палитр', 'макет',
    'graphic', 'icon', 'logo', 'image', 'picture', 'illustrat', 'banner', 'palette', 'mockup', 'mock-up', 'visual',
  ])],
  ['marketing', rx([
    'маркетинг', 'seo', 'сео', 'реклам', 'продвижен', 'воронк', 'аудитори', 'позиционир', 'бренд', 'контент-план', 'smm', 'конверси',
    'marketing', 'advertis', 'promotion', 'funnel', 'audience', 'positioning', 'brand', 'content plan', 'conversion', 'campaign', 'go-to-market',
  ])],
  ['research', rx([
    'исследу', 'исследован', 'изучи', 'сравни', 'рынок', 'рынка', 'конкурент', 'источник', 'research', 'найди информац',
    'investigat', 'compare', 'comparison', 'market research', 'competitor', 'sources', 'find information', 'look up',
  ])],
  ['data', rx([
    'данных', 'данные', 'sql', 'аналитик', 'метрик', 'таблиц', 'csv', 'dataset', 'статистик',
    'data', 'analytics', 'metric', 'table', 'statistic', 'spreadsheet', 'pandas', 'dashboard',
  ])],
  ['frontend', rx([
    'ui', 'ux', 'интерфейс', 'вёрстк', 'верстк', 'css', 'react', 'vue', 'компонент', 'кнопк', 'страниц', 'tailwind', 'html', 'layout',
    'interface', 'component', 'button', 'page', 'frontend', 'front-end', 'responsive', 'svelte', 'angular', 'nuxt',
  ])],
  ['writing', rx([
    'текст', 'стать', 'пост', 'документац', 'readme', 'перевед', 'переведи', 'письмо', 'описани',
    'text', 'article', 'blog', 'documentation', 'docs', 'translat', 'letter', 'email', 'description', 'essay', 'copywriting',
  ])],
  ['planning', rx([
    'план', 'роадмап', 'roadmap', 'этап', 'сроки', 'декомпоз', 'спецификац', 'требован', 'приоритет',
    'plan', 'milestone', 'deadline', 'timeline', 'decompos', 'specification', 'requirement', 'priorit', 'estimat',
  ])],
  ['code', rx([
    'код', 'функци', 'класс', 'баг', 'ошибк', 'тест', 'api', 'endpoint', 'бэкенд', 'backend', 'сервер', 'компил', 'сборк', 'deploy', 'docker',
    'скрипт', 'репозитор', 'git', 'code', 'function', 'class', 'bug', 'error', 'test', 'server', 'compil', 'build', 'script', 'repo', 'debug',
    'exception', 'crash', 'typescript', 'python', 'golang', 'rust', 'java',
  ])],
];

export function isSmallTalk(text: string): boolean {
  const t = text.trim();
  return t.length < 40 && SMALL_TALK.test(t) && !CHANGE.test(t);
}

export function heuristicAssessment(text: string): Assessment {
  const trimmed = text.trim();
  const needsChanges = CHANGE.test(trimmed);
  const hard = HARD.test(trimmed) || trimmed.length > 1500;
  const tier: Tier = CRITICAL.test(trimmed) ? 'critical' : hard ? 'hard' : trimmed.length < 80 && !needsChanges ? 'trivial' : 'standard';

  let domain: Domain = 'other';
  let best = 0;
  for (const [d, re] of DOMAIN_WORDS) {
    const hits = trimmed.match(new RegExp(re.source, 'giu'))?.length ?? 0;
    if (hits > best) {
      best = hits;
      domain = d;
    }
  }
  return { tier, domain, needsChanges, team: TEAM.test(trimmed), reason: t().reasons.heuristic, via: 'heuristic' };
}
