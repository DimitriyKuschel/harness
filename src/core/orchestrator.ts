import { randomUUID } from 'node:crypto';
import { t } from '../i18n';
import { parsePlan, parseStatus, stripPlanBlock } from './plan';
import { prompts } from './prompts';
import type { Logger } from './proc';
import { truncate } from './proc';
import { type Router, bumpTier, effectiveUsage, heuristicAssessment, quotaPenalty, shiftTier, type RouteContext } from './router';
import {
  AGENT_IDS,
  AGENT_LABELS,
  TIERS,
  messageText,
  type AgentAdapter,
  type AgentEvent,
  type AgentId,
  type AgentLimits,
  type ChatMessage,
  type Conversation,
  type MessageKind,
  type PlanTask,
  type Prefs,
  type Profile,
  type RouteInfo,
  type Tier,
  type ToolPart,
} from './types';

export interface OrchestratorDeps {
  adapters: Record<AgentId, AgentAdapter>;
  router: Router;
  log: Logger;
  cwd: () => string;
  /** Installed and enabled agents. */
  available: () => AgentId[];
  limits: () => Partial<Record<AgentId, AgentLimits>>;
  onLimits: (agent: AgentId, limits: AgentLimits) => void;
  /** An agent finished a run started at `startedAt` (its quota has moved). */
  onRunEnd: (agent: AgentId, startedAt: number) => void;
  /** Conversation changed (stream tick, new message…). */
  onChange: () => void;
  /** A run finished: persist. */
  onSettled: (conv: Conversation) => void;
  /** Autopilot: how many plan → tasks → check iterations one team run may take. */
  maxIterations: () => number;
  /** The CEO queued a message: autopilot yields to it at the next iteration boundary. */
  hasQueued: () => boolean;
  /** How many rounds in a row agents may hand the turn to each other by @mention (0 — never). */
  maxHandoffs: () => number;
}

interface DispatchOpts {
  route: RouteInfo;
  task: string;
  kind: MessageKind;
  /** Highest message index the agent may be shown as chat context. */
  contextUntil: number;
  /** After the run the agent counts as having seen up to here. */
  seenAfter: number;
  /** Messages quoted in `task` already — don't repeat them as context. */
  excludeIds?: string[];
  replyTo?: string;
  round?: string;
  ephemeral?: boolean;
  /** Reuse a placeholder (e.g. the "routing…" bubble). */
  message?: ChatMessage;
  subtitle?: string;
  taskId?: string;
  goal?: string;
  iteration?: number;
  /** Kept on the message so the run can be repeated (plan tasks, the lead's report). */
  prompt?: string;
}

const CONTEXT_CHAR_BUDGET = 24_000;
const PER_MESSAGE_CHARS = 4_000;

/** Replies whose @mentions hand the turn to a colleague. Brainstorms discuss in parallel; team runs follow the lead's plan. */
const HANDOFF_KINDS = new Set<MessageKind | undefined>(['answer', 'review', 'fix']);

const MENTION_ALIASES: Record<string, AgentId | 'all'> = {
  claude: 'claude',
  клод: 'claude',
  codex: 'codex',
  кодекс: 'codex',
  gemini: 'gemini',
  джемини: 'gemini',
  гемини: 'gemini',
  agy: 'gemini',
  antigravity: 'gemini',
  all: 'all',
  все: 'all',
  team: 'all',
  команда: 'all',
};

export function parseMentions(text: string): { agents: AgentId[]; all: boolean } {
  const agents = new Set<AgentId>();
  let all = false;
  for (const m of text.matchAll(/(?<![\p{L}\p{N}])@([\p{L}\p{N}_-]+)/gu)) {
    const target = MENTION_ALIASES[m[1].toLowerCase()];
    if (target === 'all') all = true;
    else if (target) agents.add(target);
  }
  return { agents: AGENT_IDS.filter((id) => agents.has(id)), all };
}

/** Colleagues an agent addresses in its reply. Code blocks and quotes cite text rather than address anyone. */
export function handoffMentions(text: string): { agents: AgentId[]; all: boolean } {
  const prose = text
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .split('\n')
    .filter((line) => !/^\s*>/.test(line))
    .join('\n');
  return parseMentions(prose);
}

export function newConversation(): Conversation {
  const now = Date.now();
  return { id: randomUUID(), title: t().newChat, createdAt: now, updatedAt: now, messages: [], sessions: {} };
}

export class Orchestrator {
  conversation: Conversation = newConversation();
  private controllers = new Map<AbortController, string | undefined>();

  constructor(private readonly deps: OrchestratorDeps) {}

  get running(): boolean {
    return this.controllers.size > 0;
  }

  busyAgents(): Set<AgentId> {
    const busy = new Set<AgentId>();
    for (const m of this.conversation.messages) if (m.agent && (m.status === 'streaming' || m.status === 'routing')) busy.add(m.agent);
    return busy;
  }

  load(conv: Conversation): void {
    this.stop();
    // Runs interrupted by a reload can't be resumed: mark them stopped.
    for (const m of conv.messages) {
      if (m.status === 'streaming' || m.status === 'routing') m.status = 'stopped';
      for (const t of m.plan ?? []) if (t.status === 'running' || t.status === 'pending') t.status = 'stopped';
    }
    this.conversation = conv;
    this.deps.onChange();
  }

  stop(): void {
    for (const ac of this.controllers.keys()) ac.abort();
    for (const m of this.conversation.messages) if (m.status === 'routing') m.status = 'stopped';
    this.deps.onChange();
  }

  // ---------- Entry points ----------

  async send(text: string, prefs: Prefs): Promise<void> {
    const conv = this.conversation;
    const user = this.add({ role: 'user', parts: [{ type: 'text', text }], status: 'done' });
    if (conv.messages.filter((m) => m.role === 'user').length === 1) conv.title = truncate(text.replace(/\s+/g, ' ').trim(), 60);
    const userIdx = conv.messages.indexOf(user);

    const available = this.deps.available();
    if (!available.length) {
      this.notice(t().notices.noAgents, user.id);
      return this.settle();
    }

    const mentions = parseMentions(text);
    const mentioned = mentions.agents.filter((a) => available.includes(a));
    const missing = mentions.agents.filter((a) => !available.includes(a));
    if (missing.length) this.notice(t().notices.unavailable(missing.map((a) => AGENT_LABELS[a]).join(', ')), user.id);

    const ctx = this.routeContext(prefs, userIdx);
    const base = { contextUntil: userIdx - 1, seenAfter: userIdx, replyTo: user.id };

    try {
      if (prefs.mode === 'brainstorm' || mentions.all) {
        const team = mentioned.length >= 2 ? mentioned : available;
        await this.brainstorm(text, user, team, prefs);
      } else if (prefs.mode === 'team' && mentioned.length !== 1 && available.length >= 2) {
        await this.teamwork(text, user, mentioned.length >= 2 ? mentioned : available, prefs);
      } else if (mentioned.length) {
        const answers = await Promise.all(
          mentioned.map((agent) =>
            this.dispatch({
              ...base,
              route: this.deps.router.forAgent(agent, text, ctx, undefined, this.lastTier(agent, userIdx)),
              task: ceoTask(text, mentioned.length > 1),
              kind: 'answer',
            }),
          ),
        );
        await this.relay(answers, prefs);
      } else {
        const placeholder = this.add({ role: 'agent', parts: [], status: 'routing', replyTo: user.id });
        const ac = this.track(placeholder.id);
        let route: RouteInfo;
        let team = false;
        try {
          ({ route, team } = await this.deps.router.route(text, ctx, ac.signal));
        } catch (e) {
          if (ac.signal.aborted) return;
          placeholder.status = 'error';
          placeholder.error = errorText(e);
          return;
        } finally {
          this.controllers.delete(ac);
        }
        if (placeholder.status === 'stopped') return;
        if (team) await this.teamwork(text, user, available, prefs, { placeholder, route });
        else await this.relay([await this.dispatch({ ...base, route, task: ceoTask(text, false), kind: 'answer', message: placeholder })], prefs);
      }
    } finally {
      this.settle();
    }
  }

  /** Another vendor's agent reviews an answer (read-only). */
  async review(messageId: string, prefs: Prefs): Promise<void> {
    const target = this.find(messageId);
    if (!target?.agent) return;
    const ctx = this.routeContext(prefs, this.conversation.messages.length);
    const domain = target.route?.domain ?? 'code';
    const reviewer = this.deps.router.pickAgent({ domain }, { ...ctx, busy: new Set() }, [target.agent]);
    if (!reviewer) {
      this.notice(t().notices.reviewNeedsSecond, target.id);
      return this.settle();
    }
    const question = this.find(target.replyTo ?? '');
    const tier = clampTier(target.route?.tier ?? 'standard', discussionTier(question ? messageText(question) : '', prefs.profile), 'critical');
    const route = this.deps.router.finish(reviewer, { ...heuristicAssessment(''), tier, domain, reason: t().reasons.review(AGENT_LABELS[target.agent]) }, { ...ctx, autonomy: 'readonly' }, 'system', true);
    const last = this.conversation.messages.length - 1;
    try {
      const msg = await this.dispatch({
        route,
        kind: 'review',
        replyTo: target.id,
        contextUntil: last,
        seenAfter: last,
        excludeIds: [target.id],
        task: reviewTask(target, question),
      });
      await this.relay([msg], prefs);
    } finally {
      this.settle();
    }
  }

  /** The original author addresses a review. */
  async fix(reviewId: string, prefs: Prefs): Promise<void> {
    const review = this.find(reviewId);
    const target = this.find(review?.replyTo ?? '');
    if (!review?.agent || !target?.agent) return;
    const ctx = this.routeContext(prefs, this.conversation.messages.length);
    const route = this.deps.router.forAgent(target.agent, '', ctx, target.route?.tier ?? 'standard');
    route.reason = t().reasons.fix(AGENT_LABELS[review.agent]);
    route.domain = target.route?.domain ?? route.domain;
    const last = this.conversation.messages.length - 1;
    try {
      const msg = await this.dispatch({
        route,
        kind: 'fix',
        replyTo: review.id,
        contextUntil: last,
        seenAfter: last,
        excludeIds: [review.id],
        task: prompts().fix(AGENT_LABELS[review.agent], messageText(review)),
      });
      await this.relay([msg], prefs);
    } finally {
      this.settle();
    }
  }

  /** Same agent again: one tier up ("Stronger"), or the same tier after a failure. */
  async rerun(messageId: string, prefs: Prefs, stronger: boolean): Promise<void> {
    const target = this.find(messageId);
    if (!target?.agent || !this.deps.available().includes(target.agent)) return;
    const question = this.find(target.replyTo ?? '');
    if (target.kind === 'plan') {
      // A failed plan: plan (and execute) again — from the CEO's message, or the next iteration after a check.
      const goal = this.find(target.goal ?? '') ?? question;
      if (question?.kind === 'report') return this.continueTeam(question.id, prefs);
      if (!goal) return;
      try {
        return await this.teamwork(messageText(goal), goal, this.deps.available(), prefs);
      } finally {
        this.settle();
      }
    }
    const current = target.route?.tier ?? 'standard';
    const ctx = this.routeContext(prefs, this.conversation.messages.length);
    const route = this.deps.router.forAgent(target.agent, '', ctx, stronger ? bumpTier(current) : current);
    route.reason = stronger ? t().reasons.stronger : t().reasons.retry;
    route.domain = target.route?.domain ?? route.domain;
    if (target.route && (target.kind === 'brainstorm' || target.kind === 'debate' || target.kind === 'review')) route.autonomy = target.route.autonomy;
    const last = this.conversation.messages.length - 1;
    const instruction = stronger ? prompts().stronger : prompts().retry;
    const brief = target.prompt ?? (question ? prompts().taskQuote(messageText(question)) : '');
    const planTask = target.taskId ? question?.plan?.find((t) => t.id === target.taskId) : undefined;
    if (planTask) planTask.status = 'running';
    try {
      const msg = await this.dispatch({
        route,
        kind: target.kind ?? 'answer',
        replyTo: target.replyTo,
        round: target.round,
        subtitle: target.subtitle,
        taskId: target.taskId,
        goal: target.goal,
        iteration: target.iteration,
        prompt: target.prompt,
        contextUntil: last,
        seenAfter: last,
        task: [instruction, brief].join('\n'),
      });
      if (planTask) {
        planTask.messageId = msg.id;
        planTask.status = taskStatus(msg);
      }
      if (msg.kind === 'report') this.takePlan(msg, { ...ctx, available: this.deps.available() });
      else await this.relay([msg], prefs);
    } finally {
      this.settle();
    }
  }

  /** Another discussion round on a brainstorm: everyone critiques everyone, then a fresh synthesis. */
  async debate(roundId: string, prefs: Prefs): Promise<void> {
    const conv = this.conversation;
    const roundMsgs = conv.messages.filter((m) => m.round === roundId);
    const question = this.find(roundMsgs[0]?.replyTo ?? '');
    const available = this.deps.available();
    const team = [...new Set(roundMsgs.filter((m) => m.kind !== 'synthesis' && m.status === 'done' && m.agent).map((m) => m.agent!))].filter((a) =>
      available.includes(a),
    );
    if (!question || team.length < 2) return;

    const round = randomUUID();
    const ctx = this.routeContext(prefs, conv.messages.length);
    const tier = discussionTier(messageText(question), prefs.profile);
    const last = conv.messages.length - 1;
    try {
      const answers = await Promise.all(
        team.map((agent) =>
          this.dispatch({
            route: this.deps.router.finish(agent, { ...heuristicAssessment(''), tier, reason: t().reasons.debate }, { ...ctx, autonomy: 'readonly' }, 'system', true),
            kind: 'debate',
            round,
            replyTo: question.id,
            contextUntil: last,
            seenAfter: last,
            task: prompts().debate(messageText(question)),
          }),
        ),
      );
      await this.synthesize(round, question, answers, prefs);
    } finally {
      this.settle();
    }
  }

  // ---------- Modes ----------

  private async brainstorm(text: string, user: ChatMessage, team: AgentId[], prefs: Prefs): Promise<void> {
    const round = randomUUID();
    const userIdx = this.conversation.messages.indexOf(user);
    const ctx = this.routeContext(prefs, userIdx);
    const h = heuristicAssessment(text);
    const tier = discussionTier(text, prefs.profile);

    const answers = await Promise.all(
      team.map((agent) =>
        this.dispatch({
          route: this.deps.router.finish(agent, { ...h, tier, reason: t().reasons.brainstorm }, { ...ctx, autonomy: 'readonly' }, 'system', true),
          kind: 'brainstorm',
          round,
          replyTo: user.id,
          contextUntil: userIdx - 1,
          seenAfter: userIdx,
          task: prompts().brainstorm(text),
        }),
      ),
    );
    await this.synthesize(round, user, answers, prefs);
  }

  private async synthesize(round: string, question: ChatMessage, answers: ChatMessage[], prefs: Prefs): Promise<void> {
    const ok = answers.filter((m) => m.status === 'done' && messageText(m));
    if (ok.length < 2) return;
    const ctx = this.routeContext(prefs, this.conversation.messages.length);
    const moderator = this.deps.router.pickAgent({ domain: 'planning' }, { ...ctx, busy: new Set() });
    if (!moderator) return;
    const tier = discussionTier(messageText(question), prefs.profile);
    const last = this.conversation.messages.length - 1;
    await this.dispatch({
      route: this.deps.router.finish(moderator, { ...heuristicAssessment(''), tier, reason: t().reasons.synthesis }, { ...ctx, autonomy: 'readonly' }, 'system', true),
      kind: 'synthesis',
      round,
      replyTo: question.id,
      contextUntil: last,
      seenAfter: last,
      ephemeral: true,
      task: prompts().synthesis(
        messageText(question),
        ok.map((m) => `\n### ${AGENT_LABELS[m.agent!]}\n${truncate(messageText(m), 6000)}`).join('\n'),
      ),
    });
  }

  /**
   * Team mode: the lead plans and assigns tasks by strengths; the team executes them (different agents in
   * parallel, each agent's own tasks in turn, dependencies first); the lead checks the result. With autopilot
   * the check also plans the next iteration, until the goal is reached or the CEO is needed.
   */
  private async teamwork(
    text: string,
    user: ChatMessage,
    team: AgentId[],
    prefs: Prefs,
    routed?: { placeholder: ChatMessage; route: RouteInfo },
  ): Promise<void> {
    const userIdx = this.conversation.messages.indexOf(user);
    const ctx = { ...this.routeContext(prefs, userIdx), available: team };
    const lead = this.leadFor(ctx);
    if (!lead) return;

    const assessed = routed?.route.tier ?? heuristicAssessment(text).tier;
    const reason = routed ? t().reasons.teamTask(routed.route.reason) : t().reasons.leadPlan;
    const plan = await this.dispatch({
      route: this.deps.router.finish(
        lead,
        { ...heuristicAssessment(text), tier: clampTier(assessed, 'standard', 'hard'), domain: 'planning', reason },
        { ...ctx, autonomy: 'readonly' },
        routed?.route.via ?? 'system',
      ),
      kind: 'plan',
      replyTo: user.id,
      goal: user.id,
      iteration: 1,
      contextUntil: userIdx - 1,
      seenAfter: userIdx,
      task: prompts().lead(text, this.deps.router.roster(ctx)),
      message: routed?.placeholder,
    });
    const tasks = this.takePlan(plan, ctx);
    if (tasks?.length) await this.teamLoop(plan, tasks, user, lead, prefs, 1);
  }

  /** "Another iteration" under the lead's check: run the plan it already made, or plan the next step. */
  async continueTeam(reportId: string, prefs: Prefs): Promise<void> {
    const report = this.find(reportId);
    const goal = this.find(report?.goal ?? '');
    if (!report || !goal) return;
    const team = this.deps.available();
    const ctx = { ...this.routeContext(prefs, this.conversation.messages.length), available: team };
    const lead = this.leadFor(ctx, report.agent);
    if (!lead) return;
    const iteration = (report.iteration ?? 1) + 1;
    try {
      if (report.plan?.length && report.plan.every((t) => t.status === 'pending')) {
        return await this.teamLoop(report, report.plan, goal, lead, prefs, iteration);
      }
      const last = this.conversation.messages.length - 1;
      const plan = await this.dispatch({
        route: this.deps.router.finish(
          lead,
          { ...heuristicAssessment(''), tier: 'standard', domain: 'planning', reason: t().reasons.leadIterationPlan(iteration) },
          { ...ctx, autonomy: 'readonly' },
          'system',
        ),
        kind: 'plan',
        replyTo: report.id,
        goal: goal.id,
        iteration,
        contextUntil: last,
        seenAfter: last,
        task: prompts().nextPlan(truncate(messageText(goal), 4000), iteration, this.deps.router.roster(ctx)),
      });
      const tasks = this.takePlan(plan, ctx);
      if (tasks?.length) await this.teamLoop(plan, tasks, goal, lead, prefs, iteration);
    } finally {
      this.settle();
    }
  }

  /** The same lead across iterations unless its quota runs low; otherwise the best planner available. */
  private leadFor(ctx: RouteContext, prefer?: AgentId): AgentId | undefined {
    if (prefer && ctx.available.includes(prefer) && quotaPenalty(ctx.limits[prefer]) < 3) return prefer;
    return this.deps.router.pickAgent({ domain: 'planning' }, { ...ctx, busy: new Set() });
  }

  /** Reads the lead's blocks (plan, verdict), hides them from the chat and attaches the tasks. */
  private takePlan(msg: ChatMessage, ctx: RouteContext): PlanTask[] | undefined {
    if (msg.status !== 'done') return undefined;
    const raw = messageText(msg);
    const tasks = parsePlan(raw, (domain, wanted) => {
      const ok = (id: string): id is AgentId => ctx.available.includes(id as AgentId) && quotaPenalty(ctx.limits[id as AgentId]) < 100;
      return wanted && ok(wanted) ? wanted : this.deps.router.pickAgent({ domain }, { ...ctx, busy: new Set() });
    });
    const status = parseStatus(raw);
    if (status) msg.teamStatus = status;
    for (const p of msg.parts) if (p.type === 'text') p.text = stripPlanBlock(p.text);
    if (tasks?.length) msg.plan = tasks;
    else if (!tasks && raw.includes('```team-plan')) this.notice(t().notices.planUnparsed(msg.kind === 'plan'), msg.id);
    this.deps.onChange();
    return tasks;
  }

  /** Executes a plan, lets the lead check it, and with autopilot keeps going while the lead says «continue». */
  private async teamLoop(planMsg: ChatMessage, tasks: PlanTask[], goal: ChatMessage, lead: AgentId, prefs: Prefs, iteration: number): Promise<void> {
    const ac = this.track(planMsg.id); // keeps the team "running" and lets Stop cancel tasks not started yet
    const max = Math.max(1, this.deps.maxIterations());
    try {
      for (;;) {
        await this.runPlan(planMsg, tasks, lead, prefs, ac.signal, iteration, goal.id);
        if (ac.signal.aborted) return;
        if (!tasks.some((t) => t.status === 'done')) {
          this.notice(t().notices.noTaskDone, planMsg.id);
          return;
        }

        const team = this.deps.available();
        const ctx = { ...this.routeContext(prefs, this.conversation.messages.length), available: team };
        const mayPlan = prefs.autopilot && iteration < max;
        const last = this.settledUntil();
        const prompt = reportTask(messageText(goal), tasks, iteration, mayPlan ? this.deps.router.roster(ctx) : undefined);
        const notices = t().notices;
        const report = await this.dispatch({
          route: this.deps.router.finish(
            this.leadFor(ctx, lead) ?? lead,
            { ...heuristicAssessment(''), tier: discussionTier(messageText(goal), prefs.profile), domain: 'planning', reason: t().reasons.leadCheck(iteration) },
            ctx,
            'system',
            true,
          ),
          kind: 'report',
          replyTo: planMsg.id,
          goal: goal.id,
          iteration,
          contextUntil: last,
          seenAfter: last,
          task: prompt,
          prompt,
        });
        if (report.status !== 'done' || ac.signal.aborted) return;
        const next = this.takePlan(report, ctx);
        if (report.teamStatus?.status !== 'continue' || !prefs.autopilot) return;

        const stop = (why: string) => this.notice(notices.autopilotStopped(why), report.id);
        if (iteration >= max) return stop(notices.stopIterations(max));
        if (this.deps.hasQueued()) return stop(notices.stopQueued);
        if (team.every((a) => effectiveUsage(ctx.limits[a]) >= 90)) return stop(notices.stopQuota);
        if (!next?.length) return stop(notices.stopNoPlan);

        planMsg = report;
        tasks = next;
        lead = report.agent ?? lead;
        iteration++;
        this.controllers.set(ac, planMsg.id);
      }
    } finally {
      this.controllers.delete(ac);
      for (const t of tasks) if (t.status === 'running') t.status = 'stopped';
      if (ac.signal.aborted) for (const t of tasks) if (t.status === 'pending') t.status = 'stopped';
      this.deps.onChange();
    }
  }

  private async runPlan(
    plan: ChatMessage,
    tasks: PlanTask[],
    lead: AgentId,
    prefs: Prefs,
    signal: AbortSignal,
    iteration: number,
    goalId: string,
  ): Promise<void> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    const failed = (t: PlanTask) => t.status === 'error' || t.status === 'stopped' || t.status === 'skipped';
    const active = new Map<string, Promise<void>>();
    const { reasons } = t();
    const iterationLabel = iteration > 1 ? `${t().iteration(iteration)} · ` : '';

    const run = async (t: PlanTask) => {
      const n = tasks.indexOf(t) + 1;
      const ctx = this.routeContext(prefs, this.conversation.messages.length);
      const route = this.deps.router.finish(
        t.agent,
        { ...heuristicAssessment(''), tier: t.tier, domain: t.domain, reason: reasons.planTask(n, tasks.length, AGENT_LABELS[lead]) },
        ctx,
        'system',
      );
      const last = this.settledUntil();
      const prompt = prompts().taskBrief(n, tasks.length, AGENT_LABELS[lead], t.title, t.task, t.scope);
      const msg = this.add({ role: 'agent', parts: [], status: 'streaming' });
      t.messageId = msg.id;
      await this.dispatch({
        route,
        kind: 'task',
        replyTo: plan.id,
        goal: goalId,
        iteration,
        taskId: t.id,
        subtitle: `${iterationLabel}${n}/${tasks.length} · ${t.title}`,
        contextUntil: last,
        seenAfter: last,
        task: prompt,
        prompt,
        message: msg,
      });
      t.status = taskStatus(msg);
      this.deps.onSettled(this.conversation); // persist progress: team runs can take hours
    };

    for (;;) {
      if (signal.aborted) return;
      for (const t of tasks) if (t.status === 'pending' && t.dependsOn.some((d) => failed(byId.get(d)!))) t.status = 'skipped';
      // One task per agent at a time: each agent has a single native session.
      const busy = new Set(tasks.filter((t) => t.status === 'running').map((t) => t.agent));
      for (const t of tasks) {
        if (t.status !== 'pending' || busy.has(t.agent) || !t.dependsOn.every((d) => byId.get(d)!.status === 'done')) continue;
        busy.add(t.agent);
        t.status = 'running';
        active.set(t.id, run(t).finally(() => active.delete(t.id)));
      }
      this.deps.onChange();
      if (!active.size) break;
      await Promise.race(active.values());
    }
    // Whatever is still pending waits on a dependency cycle.
    for (const t of tasks) if (t.status === 'pending') t.status = 'skipped';
  }

  // ---------- Handoffs ----------

  /**
   * An agent that addresses a colleague with @name hands them the turn: the colleague gets the message and
   * answers next, and may hand the turn on. Stops when nobody is addressed, at the CEO's limit, on Stop,
   * or when the CEO has queued a message.
   */
  private async relay(replies: ChatMessage[], prefs: Prefs): Promise<void> {
    const max = this.deps.maxHandoffs();
    if (max <= 0) return;
    const ac = this.track(); // keeps the chat "running" between rounds and lets Stop end the relay
    try {
      for (let round = 0; ; round++) {
        const asks = this.handoffs(replies);
        if (!asks.size || ac.signal.aborted) return;
        const notices = t().notices;
        const waiting = [...asks].map(([agent, from]) => notices.calledBy(AGENT_LABELS[agent], senders(from))).join(', ');
        const anchor = replies[replies.length - 1].id;
        if (round >= max) return this.notice(notices.handoffLimit(max, waiting), anchor);
        if (this.deps.hasQueued()) return this.notice(notices.handoffDeferred(waiting), anchor);
        replies = await Promise.all([...asks].map(([agent, from]) => this.handoff(agent, from, prefs)));
      }
    } finally {
      this.controllers.delete(ac);
    }
  }

  /** Colleagues addressed in these replies who haven't seen them yet, each with the replies that address them. */
  private handoffs(replies: ChatMessage[]): Map<AgentId, ChatMessage[]> {
    const msgs = this.conversation.messages;
    const available = this.deps.available();
    const busy = this.busyAgents();
    const asks = new Map<AgentId, ChatMessage[]>();
    const skipped = new Set<AgentId>();
    for (const m of replies) {
      if (m.status !== 'done' || !m.agent || !HANDOFF_KINDS.has(m.kind)) continue;
      const { agents, all } = handoffMentions(messageText(m));
      for (const agent of all ? AGENT_IDS : agents) {
        if (agent === m.agent || (all && !available.includes(agent))) continue;
        if (!available.includes(agent) || busy.has(agent)) {
          skipped.add(agent);
          continue;
        }
        if ((this.conversation.sessions[agent]?.seen ?? -1) >= msgs.indexOf(m)) continue;
        asks.set(agent, [...(asks.get(agent) ?? []), m]);
      }
    }
    if (skipped.size) {
      const notices = t().notices;
      const list = [...skipped].map((a) => `${AGENT_LABELS[a]}${busy.has(a) ? notices.busy : ''}`).join(', ');
      this.notice(notices.noHandoff(list), replies[replies.length - 1].id);
    }
    return asks;
  }

  private handoff(agent: AgentId, from: ChatMessage[], prefs: Prefs): Promise<ChatMessage> {
    const last = this.settledUntil();
    const ctx = this.routeContext(prefs, last + 1);
    // The request keeps the level of the work it continues: the caller's and the agent's own.
    const floor = highestTier([this.lastTier(agent, last + 1), ...from.map((m) => m.route?.tier)]);
    const asked = from.map((m) => addressedTo(messageText(m), agent)).join('\n\n');
    const route = this.deps.router.forAgent(agent, asked, ctx, undefined, floor);
    route.reason = t().reasons.askedBy(senders(from));
    const prompt = handoffTask(from);
    this.deps.log.info(`handoff: ${from.map((m) => m.agent).join(', ')} → ${agent} (${route.tier})`);
    return this.dispatch({
      route,
      kind: 'answer',
      replyTo: from[0].id,
      subtitle: route.reason,
      contextUntil: last,
      seenAfter: last,
      excludeIds: from.map((m) => m.id),
      task: prompt,
      prompt,
    });
  }

  // ---------- Execution ----------

  private async dispatch(o: DispatchOpts): Promise<ChatMessage> {
    const { route } = o;
    const conv = this.conversation;
    const msg = o.message ?? this.add({ role: 'agent', parts: [], status: 'streaming' });
    Object.assign(msg, {
      agent: route.agent,
      route,
      kind: o.kind,
      replyTo: o.replyTo,
      round: o.round,
      subtitle: o.subtitle,
      taskId: o.taskId,
      goal: o.goal,
      iteration: o.iteration,
      prompt: o.prompt,
      status: 'streaming' as const,
      createdAt: Date.now(),
    });
    this.deps.onChange();

    const ac = this.track(msg.id);
    try {
      let session = o.ephemeral ? undefined : conv.sessions[route.agent];
      for (let attempt = 0; attempt < 2; attempt++) {
        const context = o.ephemeral ? '' : this.contextFor(route.agent, session?.seen ?? -1, o.contextUntil, o.excludeIds ?? []);
        const prompt = context ? `${context}\n\n---\n\n${o.task}` : o.task;
        const outcome = await this.deps.adapters[route.agent].run(
          {
            prompt,
            cwd: this.deps.cwd(),
            model: route.model,
            effort: route.effort,
            autonomy: route.autonomy,
            sessionId: session?.id,
            systemPrompt: o.ephemeral ? undefined : teamBrief(route.agent, this.deps.cwd()),
            ephemeral: o.ephemeral,
          },
          (ev) => this.apply(msg, ev),
          ac.signal,
        );

        // A stale native session (deleted, other machine): start fresh once.
        if (!outcome.ok && session && !ac.signal.aborted && !msg.parts.length && /session|conversation|thread|not found|no such/i.test(outcome.error ?? '')) {
          this.deps.log.info(`${route.agent}: session ${session.id} unusable (${outcome.error}); starting a new one`);
          delete conv.sessions[route.agent];
          session = undefined;
          continue;
        }

        if (outcome.sessionId && !o.ephemeral) {
          conv.sessions[route.agent] = { id: outcome.sessionId, seen: Math.max(session?.seen ?? -1, o.seenAfter) };
        }
        if (outcome.usage) msg.usage = outcome.usage;
        if (!msg.parts.some((p) => p.type === 'text') && outcome.text) msg.parts.push({ type: 'text', text: outcome.text });
        if (ac.signal.aborted) msg.status = 'stopped';
        else if (outcome.ok) msg.status = 'done';
        else {
          msg.status = 'error';
          msg.error = outcome.error;
        }
        break;
      }
    } catch (e) {
      msg.status = ac.signal.aborted ? 'stopped' : 'error';
      msg.error = errorText(e);
      this.deps.log.error(`${route.agent} run failed: ${errorText(e)}`);
    } finally {
      this.controllers.delete(ac);
      for (const p of msg.parts) if (p.type === 'tool' && p.status === 'running') p.status = msg.status === 'done' ? 'ok' : 'error';
      msg.endedAt = Date.now();
      conv.updatedAt = Date.now();
      this.deps.onChange();
      this.deps.onRunEnd(route.agent, msg.createdAt);
    }
    return msg;
  }

  private apply(msg: ChatMessage, ev: AgentEvent): void {
    switch (ev.kind) {
      case 'text': {
        const last = msg.parts[msg.parts.length - 1];
        if (last?.type === 'text') last.text += (ev.newBlock ? '\n\n' : '') + ev.delta;
        else msg.parts.push({ type: 'text', text: ev.delta });
        break;
      }
      case 'tool':
        if (!msg.parts.some((p) => p.type === 'tool' && p.id === ev.id)) {
          msg.parts.push({ type: 'tool', id: ev.id, name: ev.name, detail: ev.detail, status: 'running' });
        }
        break;
      case 'tool_done': {
        const part = msg.parts.find((p): p is ToolPart => p.type === 'tool' && p.id === ev.id);
        if (part) part.status = ev.ok ? 'ok' : 'error';
        break;
      }
      case 'usage':
        msg.usage = ev.usage;
        break;
      case 'model':
        if (msg.route) msg.route.resolvedModel = ev.model;
        break;
      case 'limits':
        if (msg.agent) this.deps.onLimits(msg.agent, ev.limits);
        break;
      case 'error':
        msg.error = ev.message;
        break;
      case 'session':
        break;
    }
    this.deps.onChange();
  }

  /** Chat messages this agent hasn't seen yet, as a compact transcript. */
  private contextFor(agent: AgentId, seen: number, until: number, exclude: string[]): string {
    const msgs = this.conversation.messages;
    const lines: string[] = [];
    let budget = CONTEXT_CHAR_BUDGET;
    for (let i = Math.min(until, msgs.length - 1); i > seen && budget > 0; i--) {
      const m = msgs[i];
      if (exclude.includes(m.id) || m.role === 'system' || m.status !== 'done') continue;
      // The agent's own replies already live in its native session (synthesis runs are ephemeral, so keep those).
      if (m.agent === agent && m.kind !== 'synthesis') continue;
      const entry = formatForContext(m);
      if (!entry) continue;
      budget -= entry.length;
      lines.unshift(entry);
    }
    if (!lines.length) return '';
    return [prompts().newMessages, '', ...lines].join('\n');
  }

  private routeContext(prefs: Prefs, beforeIdx: number): RouteContext {
    const recent = this.conversation.messages
      .slice(Math.max(0, beforeIdx - 4), beforeIdx)
      .filter((m) => m.status === 'done' && m.role !== 'system')
      .map((m) => `[${m.role === 'user' ? 'CEO' : AGENT_LABELS[m.agent!]}]: ${truncate(messageText(m).replace(/\s+/g, ' '), 300)}`)
      .join('\n');
    return {
      available: this.deps.available(),
      limits: this.deps.limits(),
      busy: this.busyAgents(),
      profile: prefs.profile,
      autonomy: prefs.autonomy,
      recent,
      cwd: this.deps.cwd(),
    };
  }

  /** Tier of the agent's latest run before `beforeIdx`, when a follow-up would resume that session. */
  private lastTier(agent: AgentId, beforeIdx: number): Tier | undefined {
    if (!this.conversation.sessions[agent]) return undefined;
    for (let i = beforeIdx - 1; i >= 0; i--) {
      const m = this.conversation.messages[i];
      if (m.role === 'agent' && m.agent === agent && m.route) return m.route.tier;
    }
    return undefined;
  }

  // ---------- Helpers ----------

  private add(m: Omit<ChatMessage, 'id' | 'createdAt'>): ChatMessage {
    const msg: ChatMessage = { id: randomUUID(), createdAt: Date.now(), ...m };
    this.conversation.messages.push(msg);
    this.conversation.updatedAt = Date.now();
    this.deps.onChange();
    return msg;
  }

  private notice(text: string, replyTo?: string): void {
    this.add({ role: 'system', kind: 'notice', parts: [{ type: 'text', text }], status: 'done', replyTo });
  }

  private find(id: string): ChatMessage | undefined {
    return this.conversation.messages.find((m) => m.id === id);
  }

  private track(messageId?: string): AbortController {
    const ac = new AbortController();
    this.controllers.set(ac, messageId);
    return ac;
  }

  /** Last index before any message still in progress: context and "seen" must not skip unfinished replies. */
  private settledUntil(): number {
    const msgs = this.conversation.messages;
    const i = msgs.findIndex((m) => m.status === 'streaming' || m.status === 'routing');
    return (i < 0 ? msgs.length : i) - 1;
  }

  private settle(): void {
    this.deps.onChange();
    this.deps.onSettled(this.conversation);
  }
}

// ---------- Prompts ----------

export function teamBrief(agent: AgentId, cwd: string): string {
  const others = AGENT_IDS.filter((a) => a !== agent).map((a) => AGENT_LABELS[a]).join(', ');
  return prompts().teamBrief(AGENT_LABELS[agent], others, cwd);
}

function ceoTask(text: string, parallel: boolean): string {
  return `[CEO]: ${text}${parallel ? prompts().parallelNote : ''}`;
}

function handoffTask(from: ChatMessage[]): string {
  const one = from.length === 1;
  const quoted = from.map((m) => `${one ? '' : `### ${AGENT_LABELS[m.agent!]}\n`}"""\n${truncate(messageText(m), 8000)}\n"""`).join('\n\n');
  return prompts().handoff(one ? AGENT_LABELS[from[0].agent!] : undefined, quoted);
}

function senders(from: ChatMessage[]): string {
  return [...new Set(from.map((m) => AGENT_LABELS[m.agent!]))].join(', ');
}

/** The paragraphs of a reply that address `agent`: what is asked of it, to judge the request's size. */
function addressedTo(text: string, agent: AgentId): string {
  return text
    .split(/\n\s*\n/)
    .filter((p) => {
      const m = handoffMentions(p);
      return m.all || m.agents.includes(agent);
    })
    .join('\n\n');
}

function reviewTask(target: ChatMessage, question?: ChatMessage): string {
  const tools = target.parts
    .filter((p): p is ToolPart => p.type === 'tool')
    .slice(0, 30)
    .map((p) => `- ${p.name}${p.detail ? `: ${p.detail}` : ''}`);
  return prompts().review(
    AGENT_LABELS[target.agent!],
    question ? truncate(messageText(question), 4000) : undefined,
    truncate(messageText(target), 8000),
    tools.join('\n'),
  );
}

function reportTask(goal: string, tasks: PlanTask[], iteration: number, roster?: string): string {
  const p = prompts();
  const lines = tasks.map((task) => p.taskLine(task.id, AGENT_LABELS[task.agent], task.title, p.taskStatus[task.status]));
  return p.report(truncate(goal, 4000), iteration, lines.join('\n'), roster);
}

function taskStatus(m: ChatMessage): PlanTask['status'] {
  return m.status === 'done' ? 'done' : m.status === 'stopped' ? 'stopped' : 'error';
}

/**
 * Brainstorms, debates, their synthesis and reviews steer the CEO's decisions, so they start at `hard`;
 * a question the CEO calls critical goes higher. The profile still shifts the result.
 */
export function discussionTier(text: string, profile: Profile): Tier {
  return shiftTier(clampTier(heuristicAssessment(text).tier, 'hard', 'critical'), profile);
}

function highestTier(tiers: (Tier | undefined)[]): Tier | undefined {
  return tiers.filter((t): t is Tier => !!t).sort((a, b) => TIERS.indexOf(b) - TIERS.indexOf(a))[0];
}

/** Keeps a tier within [min, max]. */
function clampTier(tier: Tier, min: Tier, max: Tier): Tier {
  const order: Tier[] = ['trivial', 'standard', 'hard', 'critical'];
  const i = Math.min(Math.max(order.indexOf(tier), order.indexOf(min)), order.indexOf(max));
  return order[i];
}

function formatForContext(m: ChatMessage): string {
  const c = prompts().context;
  const label = AGENT_LABELS[m.agent!];
  const who =
    m.role === 'user'
      ? 'CEO'
      : m.kind === 'synthesis'
        ? c.synthesis(label)
        : m.kind === 'plan'
          ? c.plan(label)
          : m.subtitle
            ? c.task(label, m.subtitle)
            : label;
  const text = m.kind === 'plan' ? planForContext(m) : messageText(m);
  const tools = m.parts.filter((p): p is ToolPart => p.type === 'tool');
  const edits = tools.filter((p) => /edit|write/i.test(p.name) && p.detail).map((p) => p.detail);
  const actions = edits.length ? c.edited([...new Set(edits)].slice(0, 12).join(', ')) : '';
  if (!text && !actions) return '';
  const body = text.length > PER_MESSAGE_CHARS ? `${text.slice(0, PER_MESSAGE_CHARS)}${c.truncated}` : text;
  return `[${who}]: ${body}${actions}\n`;
}

function planForContext(m: ChatMessage): string {
  const prose = stripPlanBlock(messageText(m));
  if (!m.plan?.length) return prose;
  const c = prompts().context;
  return [prose, '', c.tasks, ...m.plan.map((t) => `- ${t.id} → ${AGENT_LABELS[t.agent]}: ${t.title}${t.scope ? c.scope(t.scope) : ''}`)].join('\n');
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
