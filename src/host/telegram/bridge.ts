import { parseMentions } from '../../core/orchestrator';
import { stripPlanBlock } from '../../core/plan';
import { type Logger, truncate } from '../../core/proc';
import { exhaustedUntil } from '../../core/quota';
import {
  AGENT_IDS,
  AGENT_LABELS,
  messageText,
  type AgentId,
  type AgentView,
  type ChatMessage,
  type LimitWindow,
  type MessageStatus,
  type Prefs,
  type TaskStatus,
  type ToolPart,
  type ViewState,
} from '../../core/types';
import { formatDuration, formatReset, formatTokens, t } from '../../i18n';
import type { ToHost } from '../../protocol';
import { TelegramError, type Keyboard, type TelegramApi, type TgCallback, type TgMessage, type TgUpdate } from './api';
import { chunkMarkdown, escapeHtml, markdownToHtml, preview } from './format';

export type Bot = Pick<TelegramApi, 'getUpdates' | 'send' | 'edit' | 'delete' | 'answer' | 'setCommands' | 'deleteWebhook'>;

/** The controller, as the webview sees it: the state to show, and the same messages the webview sends. */
export interface BridgeHost {
  state(): ViewState;
  post(m: ToHost): Promise<void>;
}

export interface BridgeDeps {
  bot: Bot;
  host: BridgeHost;
  log: Logger;
  /** The CEO's private chat, once linked. */
  chatId?: number;
  onPaired: (chatId: number) => void;
  /** The token was revoked. */
  onUnauthorized: () => void;
}

/** Long answers of these kinds arrive as a preview with a "Show all" button; the rest in full. */
const PREVIEW_KINDS = new Set(['task', 'brainstorm', 'debate']);
const PREVIEW_CHARS = 900;
/** Beyond this many messages per answer, the rest waits for "Show all". */
const MAX_PARTS = 3;
const SYNC_DELAY_MS = 400;
const STATUS_EVERY_MS = 6_000;
const TICK_MS = 15_000;
const PAIRING_MS = 10 * 60_000;
/** Messages older than this were sent while nobody was polling: running them now would surprise the CEO. */
const STALE_S = 120;

const STATUS_ICONS: Record<MessageStatus, string> = { routing: '🧭', streaming: '⏳', done: '✅', error: '❌', stopped: '⏹' };
const TASK_ICONS: Record<TaskStatus, string> = { pending: '◻️', running: '⏳', done: '✅', error: '❌', stopped: '⏹', skipped: '⤼' };
const TEAM_ICONS = { done: '🏁', continue: '🔄', blocked: '❓' } as const;

/** The /mode, /profile, /access and /autopilot settings and their values. */
const SETTINGS = {
  mode: ['auto', 'team', 'brainstorm'],
  profile: ['eco', 'balanced', 'max'],
  access: ['readonly', 'auto', 'full'],
  autopilot: ['on', 'off'],
} as const;
type Setting = keyof typeof SETTINGS;

interface Sent {
  /** The Telegram messages carrying the text (empty: history from before the bridge looked, never mirrored). */
  ids: number[];
  sig: string;
  /** The plan card, edited as tasks progress. */
  card?: number;
  cardSig?: string;
  history?: boolean;
}

/**
 * Mirrors the team chat to the CEO's Telegram and runs what they send from there through the same
 * entry points as the webview. Finished messages arrive as they finish; one status message at the
 * bottom shows who is working on what, and goes away when the team is idle.
 */
export class TelegramBridge {
  private chatId?: number;
  private offset = 0;
  private poll?: AbortController;
  private conversationId?: string;
  private sent = new Map<string, Sent>();
  /** Telegram message → chat message, so a reply continues with that agent. */
  private origin = new Map<number, string>();
  /** CEO messages sent from Telegram: not echoed back. */
  private own: string[] = [];
  private status?: { id: number; text: string; at: number };
  private postedSinceStatus = false;
  private out: Promise<void> = Promise.resolve();
  private syncTimer?: NodeJS.Timeout;
  private ticker?: NodeJS.Timeout;
  private pairing?: { code: string; until: number };

  constructor(private readonly deps: BridgeDeps) {
    this.chatId = deps.chatId;
  }

  get paired(): boolean {
    return this.chatId !== undefined;
  }

  get pairingPending(): boolean {
    return !!this.pairing && Date.now() < this.pairing.until;
  }

  start(): void {
    if (this.poll) return;
    const poll = new AbortController();
    this.poll = poll;
    void this.loop(poll.signal);
    const commands = Object.entries(t().telegram.commands).map(([command, description]) => ({ command, description }));
    void this.deps.bot.setCommands(commands).catch((e) => this.deps.log.error(`telegram: setMyCommands: ${errorText(e)}`));
    this.ticker = setInterval(() => this.deps.host.state().running && this.schedule(), TICK_MS);
    this.ticker.unref?.();
    if (this.paired) this.baseline();
  }

  stop(): void {
    this.poll?.abort();
    this.poll = undefined;
    clearInterval(this.ticker);
    clearTimeout(this.syncTimer);
    this.syncTimer = undefined;
  }

  /** The CEO links their chat by sending `/start <code>` (the t.me deep link does it for them). */
  expectPairing(code: string): void {
    this.pairing = { code, until: Date.now() + PAIRING_MS };
  }

  /** The host's state changed: mirror it shortly (changes come in bursts while agents stream). */
  schedule(): void {
    if (this.syncTimer || !this.poll) return;
    this.syncTimer = setTimeout(() => {
      this.syncTimer = undefined;
      this.sync();
    }, SYNC_DELAY_MS);
    this.syncTimer.unref?.();
  }

  /** Resolves when everything queued for Telegram has been sent (tests). */
  flushed(): Promise<void> {
    return this.out;
  }

  // ---------- Polling ----------

  private async loop(signal: AbortSignal): Promise<void> {
    await this.deps.bot.deleteWebhook().catch(() => {});
    let backoff = 0;
    while (!signal.aborted) {
      try {
        const updates = await this.deps.bot.getUpdates(this.offset, signal);
        backoff = 0;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((e) => this.deps.log.error(`telegram: update ${u.update_id}: ${errorText(e)}`));
        }
      } catch (e) {
        if (signal.aborted) return;
        if (e instanceof TelegramError && e.code === 401) return this.deps.onUnauthorized();
        // 409: another process is polling this bot, e.g. a window that hasn't let go of it yet.
        backoff = Math.min(60_000, backoff ? backoff * 2 : 3_000);
        this.deps.log.error(`telegram: polling failed: ${errorText(e)}; retrying in ${backoff / 1000}s`);
        await sleep(backoff, signal);
      }
    }
  }

  private handle(u: TgUpdate): Promise<unknown> {
    if (u.message) return this.onMessage(u.message);
    if (u.callback_query) return this.onCallback(u.callback_query);
    return Promise.resolve();
  }

  private async onMessage(m: TgMessage): Promise<unknown> {
    const text = (m.text ?? '').trim();
    if (m.chat.type !== 'private' || !text) return;
    const s = t().telegram;
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?/.exec(text);
    if (start?.[1] && this.pairing && start[1] === this.pairing.code && Date.now() < this.pairing.until) {
      this.pairing = undefined;
      this.chatId = m.chat.id;
      this.baseline();
      this.deps.onPaired(m.chat.id);
      return this.reply(`${s.paired(escapeHtml(this.workspace()))}\n\n${s.help}`);
    }
    // Only the linked chat is served; anyone else who finds the bot gets nothing.
    if (m.chat.id !== this.chatId) return;
    if (Date.now() / 1000 - m.date > STALE_S) return this.reply(s.stale, { replyTo: m.message_id });
    if (start) return this.reply(s.help);
    if (text.startsWith('/')) return this.command(text);
    return this.say(text, m.reply_to_message?.message_id);
  }

  /** A task from the phone: like typing it into the chat. A reply to an agent's message addresses that agent. */
  private async say(text: string, replyTo?: number): Promise<unknown> {
    const s = t().telegram;
    const state = this.deps.host.state();
    if (!state.trusted) return this.reply(s.untrusted);
    const agent = replyTo !== undefined ? this.find(this.origin.get(replyTo))?.agent : undefined;
    const mentions = parseMentions(text);
    const body = agent && !mentions.agents.length && !mentions.all ? `@${agent} ${text}` : text;
    this.own = [...this.own.slice(-19), body];
    await this.deps.host.post({ type: 'send', text: body, prefs: state.prefs });
    const queue = this.deps.host.state().queue.length;
    if (state.running && queue) return this.reply(s.queued(queue), { silent: true });
  }

  private async command(text: string): Promise<unknown> {
    const [head, ...args] = text.slice(1).split(/\s+/);
    const name = head.replace(/@\w+$/, '').toLowerCase();
    const s = t().telegram;
    const state = this.deps.host.state();
    switch (name) {
      case 'help':
        return this.reply(s.help);
      case 'status':
        return this.reply(this.statusReport(state), { keyboard: this.statusKeyboard(state) });
      case 'stop':
        await this.deps.host.post({ type: 'stop' });
        return this.reply(s.stopped, { silent: true });
      case 'new':
        // The chat switch is announced by the next sync.
        return this.deps.host.post({ type: 'newChat' });
      case 'chats':
        return this.chats(state);
      case 'mode':
      case 'profile':
      case 'access':
      case 'autopilot':
        return this.setting(name, args[0]);
      case 'model':
      case 'models':
        return this.model(args[0], args[1]);
      default:
        return this.reply(s.unknown);
    }
  }

  private async onCallback(q: TgCallback): Promise<unknown> {
    if (q.message?.chat.id !== this.chatId) return this.deps.bot.answer(q.id).catch(() => {});
    const [kind, ...rest] = (q.data ?? '').split(':');
    const arg = rest.join(':');
    const s = t().telegram;
    const state = this.deps.host.state();
    const toast = (text?: string) => this.deps.bot.answer(q.id, text).catch(() => {});

    const run: Record<string, (id: string) => ToHost> = {
      r: (id) => ({ type: 'rerun', id, stronger: false }),
      s: (id) => ({ type: 'rerun', id, stronger: true }),
      v: (id) => ({ type: 'review', id }),
      f: (id) => ({ type: 'fix', id }),
      c: (id) => ({ type: 'continueTeam', id }),
      d: (round) => ({ type: 'debate', round }),
    };
    if (run[kind]) {
      if (!state.trusted) return toast(s.untrusted);
      if (state.running) return toast(s.busy);
      const known = kind === 'd' ? state.conversation.messages.some((m) => m.round === arg) : !!this.find(arg);
      if (!known) return toast(s.otherChat);
      await toast(s.accepted);
      return this.deps.host.post(run[kind](arg));
    }
    switch (kind) {
      case 'm': {
        const m = this.find(arg);
        if (!m) return toast(s.otherChat);
        await toast();
        return this.sendAll(m);
      }
      case 'o':
        await toast();
        return this.deps.host.post({ type: 'openChat', id: arg });
      case 'x':
        await this.deps.host.post({ type: 'stop' });
        return toast(s.stopped);
      case 'q':
        if (!isAgent(arg)) return toast();
        await this.deps.host.post({ type: 'resetQuota', agent: arg });
        return toast(s.quotaBack(AGENT_LABELS[arg]));
      case 'P': {
        const [setting, value] = arg.split(':');
        await toast();
        return this.setting(setting as Setting, value, value === 'full!');
      }
      case 'M':
        await toast();
        return this.model(arg || undefined);
      case 'pin': {
        const [agent, index] = arg.split(':');
        const view = state.agents.find((a) => a.id === agent);
        if (!view) return toast();
        await toast();
        return this.pin(view, index === '-' ? undefined : view.models[Number(index)]);
      }
      default:
        return toast();
    }
  }

  // ---------- Commands ----------

  private async setting(name: Setting, value?: string, confirmed = false): Promise<unknown> {
    const s = t().telegram;
    const prefs = this.deps.host.state().prefs;
    const values: readonly string[] = SETTINGS[name];
    const v = value?.replace(/!$/, '').toLowerCase();
    if (!v || !values.includes(v)) {
      const current = settingValue(prefs, name);
      const keyboard = [values.map((x) => ({ text: `${x === current ? '✓ ' : ''}${settingLabel(name, x)}`, callback_data: `P:${name}:${x}` }))];
      return this.reply(s.choose(settingName(name)), { keyboard, silent: true });
    }
    if (name === 'access' && v === 'full' && !confirmed) {
      return this.reply(s.confirmFull, { keyboard: [[{ text: s.confirmFullButton, callback_data: 'P:access:full!' }]], silent: true });
    }
    const next: Prefs =
      name === 'mode'
        ? { ...prefs, mode: v as Prefs['mode'] }
        : name === 'profile'
          ? { ...prefs, profile: v as Prefs['profile'] }
          : name === 'access'
            ? { ...prefs, autonomy: v as Prefs['autonomy'] }
            : { ...prefs, autopilot: v === 'on' };
    await this.deps.host.post({ type: 'prefs', prefs: next });
    return this.reply(s.set(settingName(name), settingLabel(name, v)), { silent: true });
  }

  private async model(agentArg?: string, modelArg?: string): Promise<unknown> {
    const s = t().telegram;
    const state = this.deps.host.state();
    const pins = state.prefs.models ?? {};
    const id = agentArg ? agentAlias(agentArg) : undefined;
    if (agentArg && !id) return this.reply(s.unknownAgent);
    if (!id) {
      const lines = state.agents.map((a) => (pins[a.id] ? s.pinned(a.label, `<code>${escapeHtml(pins[a.id]!)}</code>`) : s.unpinned(a.label)));
      const keyboard = [state.agents.filter((a) => a.installed && a.enabled).map((a) => ({ text: a.label, callback_data: `M:${a.id}` }))];
      return this.reply([s.models, ...lines].join('\n'), { keyboard, silent: true });
    }
    const view = state.agents.find((a) => a.id === id)!;
    if (!modelArg) {
      const rows: Keyboard = [[{ text: `${pins[id] ? '' : '✓ '}${s.auto}`, callback_data: `pin:${id}:-` }]];
      // callback_data is capped at 64 bytes: the model goes by its index in the list.
      view.models.forEach((m, i) => rows.push([{ text: `${pins[id] === m ? '✓ ' : ''}${m}`, callback_data: `pin:${id}:${i}` }]));
      return this.reply(s.modelFor(view.label), { keyboard: rows, silent: true });
    }
    if (/^(auto|авто)$/i.test(modelArg)) return this.pin(view, undefined);
    if (!view.models.includes(modelArg)) return this.reply(s.unknownModel(view.label, escapeHtml(view.models.join(', '))));
    return this.pin(view, modelArg);
  }

  private async pin(agent: AgentView, model: string | undefined): Promise<unknown> {
    const s = t().telegram;
    const prefs = this.deps.host.state().prefs;
    await this.deps.host.post({ type: 'prefs', prefs: { ...prefs, models: { ...prefs.models, [agent.id]: model } } });
    return this.reply(model ? s.pinned(agent.label, `<code>${escapeHtml(model)}</code>`) : s.unpinned(agent.label), { silent: true });
  }

  private chats(state: ViewState): Promise<unknown> {
    const s = t().telegram;
    if (!state.history.length) return this.reply(s.noChats, { silent: true });
    const keyboard = state.history.slice(0, 10).map((h) => [{ text: `${h.id === state.conversation.id ? '✓ ' : ''}${truncate(h.title, 48)}`, callback_data: `o:${h.id}` }]);
    return this.reply(s.chats, { keyboard, silent: true });
  }

  private statusReport(state: ViewState): string {
    const s = t().telegram;
    const c = t().composer;
    const p = state.prefs;
    const settings = [
      `${c.mode}: ${settingLabel('mode', p.mode)}`,
      `${c.profile}: ${settingLabel('profile', p.profile)}`,
      `${settingName('access')}: ${settingLabel('access', p.autonomy)}`,
      `${c.autopilot}: ${p.autopilot ? s.on : s.off}`,
    ].join(' · ');
    const agents = state.agents.map((a) => {
      const until = exhaustedUntil(a.limits);
      const pinned = state.prefs.models?.[a.id];
      const parts = [
        !a.installed || !a.enabled ? s.agentOff : a.busy ? s.agentBusy : s.agentIdle,
        until ? s.outOfQuota(formatReset(until)) : limitsLine(a),
        pinned ? `📌 <code>${escapeHtml(pinned)}</code>` : '',
      ].filter(Boolean);
      return `<b>${a.label}</b> — ${parts.join(' · ')}`;
    });
    const conv = state.conversation;
    const head = [
      s.statusTitle(escapeHtml(this.workspace())),
      escapeHtml(s.chatLine(conv.title, conv.messages.length)),
      state.running ? `⏳ ${s.working}` : '',
      state.queue.length ? s.queue(state.queue.length) : '',
      escapeHtml(settings),
    ].filter(Boolean);
    return [...head, '', s.agentsTitle, ...agents].join('\n');
  }

  private statusKeyboard(state: ViewState): Keyboard {
    const b = t().telegram.settingsButtons;
    const rows: Keyboard = [
      [
        { text: b.mode, callback_data: 'P:mode' },
        { text: b.profile, callback_data: 'P:profile' },
        { text: b.access, callback_data: 'P:access' },
      ],
      [
        { text: b.autopilot, callback_data: 'P:autopilot' },
        { text: b.model, callback_data: 'M:' },
      ],
    ];
    for (const a of state.agents) if (exhaustedUntil(a.limits)) rows.push([{ text: t().telegram.quotaBackButton(a.label), callback_data: `q:${a.id}` }]);
    if (state.running) rows.unshift([{ text: t().telegram.stop, callback_data: 'x:' }]);
    return rows;
  }

  // ---------- Mirroring ----------

  /**
   * Only what happens from now on is mirrored: a chat's history stays in VS Code. Taken at once, not at the
   * next sync, or a run that finishes in between would count as history.
   */
  private baseline(): void {
    const conv = this.deps.host.state().conversation;
    this.conversationId = conv.id;
    this.sent.clear();
    for (const m of conv.messages) if (settled(m)) this.sent.set(m.id, { ids: [], sig: '', history: true });
  }

  private sync(): void {
    if (this.chatId === undefined) return;
    const state = this.deps.host.state();
    const conv = state.conversation;
    if (conv.id !== this.conversationId) {
      this.baseline();
      const s = t().telegram;
      this.push(undefined, [conv.messages.length ? s.opened(escapeHtml(conv.title), conv.messages.length) : s.newChat], { silent: true });
    }
    for (const m of conv.messages) this.mirror(m, state);
    this.syncStatus(state);
  }

  private mirror(m: ChatMessage, state: ViewState): void {
    const prev = this.sent.get(m.id);
    if (prev?.history) return;
    if (m.role === 'user') {
      if (prev) return;
      const text = messageText(m);
      const own = this.own.indexOf(text);
      if (own >= 0) {
        this.own.splice(own, 1);
        this.sent.set(m.id, { ids: [], sig: '', history: true });
        return;
      }
      this.push(m.id, [`👤 <b>CEO</b>: ${markdownToHtml(text)}`], { silent: true });
      return;
    }
    if (m.role === 'system') {
      if (!prev) this.push(m.id, [`ℹ️ ${escapeHtml(messageText(m))}`], {});
      return;
    }
    if (!settled(m)) return;
    const sig = signature(m);
    const card = planCard(m);
    if (!prev) {
      const r = this.render(m, state);
      this.push(m.id, r.parts, { keyboard: r.keyboard, card, sig });
      return;
    }
    if (prev.sig !== sig) {
      prev.sig = sig;
      const r = this.render(m, state);
      this.enqueue(async () => {
        for (const [i, id] of prev.ids.entries()) if (r.parts[i]) await this.editHtml(id, r.parts[i], i === prev.ids.length - 1 ? r.keyboard : undefined);
      });
    }
    if (card && prev.cardSig !== card) {
      prev.cardSig = card;
      this.enqueue(async () => {
        if (prev.card) await this.editHtml(prev.card, card);
        else prev.card = (await this.sendHtml(card, { silent: true })).message_id;
      });
    }
  }

  /** An agent message as Telegram messages: header, text (maybe cut), team verdict, error, stats; buttons on the last. */
  private render(m: ChatMessage, state: ViewState): { parts: string[]; keyboard: Keyboard } {
    const s = t().telegram;
    const ms = t().message;
    const label = m.agent ? AGENT_LABELS[m.agent] : ms.router;
    const kind = m.kind && m.kind !== 'answer' ? ` · ${ms.kinds[m.kind]}` : '';
    const model = m.route ? ` · <code>${escapeHtml(m.route.model ?? m.route.resolvedModel ?? ms.route.defaultModel)}</code>` : '';
    const head = [`${STATUS_ICONS[m.status]} <b>${label}</b>${kind}${model}`, m.subtitle ? `<i>${escapeHtml(m.subtitle)}</i>` : ''].filter(Boolean).join('\n');

    const raw = m.kind === 'plan' || m.kind === 'report' ? stripPlanBlock(messageText(m)) : messageText(m);
    const short = PREVIEW_KINDS.has(m.kind ?? '') ? preview(raw, PREVIEW_CHARS) : { text: raw, cut: false };
    let pieces = chunkMarkdown(short.text);
    let cut = short.cut;
    if (pieces.length > MAX_PARTS) {
      pieces = pieces.slice(0, MAX_PARTS);
      cut = true;
    }
    const parts = pieces.map(markdownToHtml);
    if (cut) parts[parts.length - 1] += `\n<i>${escapeHtml(s.cut)}</i>`;

    const tools = m.parts.filter((p) => p.type === 'tool').length;
    const stats = [
      tools ? `🔧 ${tools}` : '',
      m.usage ? `${formatTokens(m.usage.input)} → ${formatTokens(m.usage.output)}` : '',
      m.endedAt ? formatDuration(m.endedAt - m.createdAt) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    const tail = [
      m.teamStatus ? `${TEAM_ICONS[m.teamStatus.status]} <b>${ms.teamStatus[m.teamStatus.status]}</b>${m.teamStatus.reason ? ` — ${escapeHtml(m.teamStatus.reason)}` : ''}` : '',
      m.status === 'error' ? `❌ ${escapeHtml(m.error || ms.error)}` : '',
      m.status === 'stopped' ? `⏹ ${ms.stopped}` : '',
      stats ? `<i>${stats}</i>` : '',
    ]
      .filter(Boolean)
      .join('\n');

    if (!parts.length) parts.push('');
    parts[0] = [head, parts[0]].filter(Boolean).join('\n\n');
    parts[parts.length - 1] = [parts[parts.length - 1], tail].filter(Boolean).join('\n\n');

    const keyboard = this.actions(m, state);
    if (cut) keyboard.push([{ text: s.more, callback_data: `m:${m.id}` }]);
    return { parts, keyboard };
  }

  /** The buttons under a finished message: the same actions as the webview's message footer. */
  private actions(m: ChatMessage, state: ViewState): Keyboard {
    const a = t().message.actions;
    const row: { text: string; callback_data: string }[] = [];
    const work = m.kind !== 'synthesis' && m.kind !== 'review' && m.kind !== 'plan';
    const redoable = work && m.kind !== 'task' && m.kind !== 'report';
    const canReview = state.agents.filter((x) => x.installed && x.enabled).length >= 2;
    if (m.status === 'error' || m.status === 'stopped') {
      const out = m.agent && exhaustedUntil(state.agents.find((x) => x.id === m.agent)?.limits);
      const elsewhere = out && m.kind !== 'brainstorm' && m.kind !== 'debate' && m.kind !== 'fix';
      row.push({ text: `${elsewhere ? '↪️' : '🔁'} ${(elsewhere ? a.retryElsewhere(AGENT_LABELS[m.agent!]) : a.retry).label}`, callback_data: `r:${m.id}` });
    }
    if (m.status === 'done') {
      if (m.kind === 'review') row.push({ text: `🛠 ${a.fix.label}`, callback_data: `f:${m.id}` });
      if (m.kind === 'report' && m.goal && m.teamStatus?.status !== 'done') row.push({ text: `▶️ ${a.continue.label}`, callback_data: `c:${m.id}` });
      if (m.kind === 'synthesis' && m.round) row.push({ text: `💬 ${a.debate.label}`, callback_data: `d:${m.round}` });
      if (work && canReview) row.push({ text: `👁 ${a.review.label}`, callback_data: `v:${m.id}` });
      if (redoable && m.route && m.route.tier !== 'critical') row.push({ text: `⬆️ ${a.stronger.label}`, callback_data: `s:${m.id}` });
    }
    // Two per row: Telegram squeezes long labels.
    const rows: Keyboard = [];
    for (let i = 0; i < row.length; i += 2) rows.push(row.slice(i, i + 2));
    return rows;
  }

  /** "Show all": the whole text, in as many messages as it takes. */
  private sendAll(m: ChatMessage): Promise<void> {
    const raw = m.kind === 'plan' || m.kind === 'report' ? stripPlanBlock(messageText(m)) : messageText(m);
    const label = m.agent ? AGENT_LABELS[m.agent] : '';
    const parts = chunkMarkdown(raw).map(markdownToHtml);
    if (parts.length) parts[0] = `📄 <b>${label}</b>${m.subtitle ? ` · <i>${escapeHtml(m.subtitle)}</i>` : ''}\n\n${parts[0]}`;
    this.push(undefined, parts, { silent: true });
    return this.out;
  }

  /** One message at the bottom while the team works: who is on what. It moves down as answers arrive. */
  private syncStatus(state: ViewState): void {
    const text = this.renderStatus(state);
    const current = this.status;
    if (!text) {
      if (current) {
        this.status = undefined;
        this.enqueue(() => this.deps.bot.delete(this.chatId!, current.id));
      }
      return;
    }
    const now = Date.now();
    if (current && (current.text === text || now - current.at < STATUS_EVERY_MS)) return;
    const keyboard = [[{ text: t().telegram.stop, callback_data: 'x:' }]];
    if (current && !this.postedSinceStatus) {
      Object.assign(current, { text, at: now });
      this.enqueue(() => this.editHtml(current.id, text, keyboard));
      return;
    }
    this.postedSinceStatus = false;
    const next = { id: 0, text, at: now };
    this.status = next;
    this.enqueue(async () => {
      if (current) await this.deps.bot.delete(this.chatId!, current.id).catch(() => {});
      next.id = (await this.sendHtml(text, { silent: true, keyboard })).message_id;
    });
  }

  private renderStatus(state: ViewState): string | undefined {
    if (!state.running) return undefined;
    const s = t().telegram;
    const ms = t().message;
    const live = state.conversation.messages.filter((m) => m.status === 'streaming' || m.status === 'routing');
    const lines = live.map((m) => {
      const who = m.agent ? AGENT_LABELS[m.agent] : ms.router;
      const what = m.subtitle ?? (m.kind && m.kind !== 'answer' ? ms.kinds[m.kind] : '');
      const tool = [...m.parts].reverse().find((p): p is ToolPart => p.type === 'tool' && p.status === 'running');
      const doing = m.status === 'routing' ? s.routing : tool ? `🔧 ${tool.name}${tool.detail ? ` ${truncate(tool.detail, 60)}` : ''}` : s.thinking;
      return `• <b>${who}</b>${what ? ` — ${escapeHtml(truncate(what, 80))}` : ''}\n   ${escapeHtml(doing)} · ${formatDuration(Date.now() - m.createdAt)}`;
    });
    return [`⏳ <b>${s.working}</b>`, ...lines, state.queue.length ? s.queue(state.queue.length) : ''].filter(Boolean).join('\n');
  }

  // ---------- Sending ----------

  /** Sends the parts in order (buttons on the last) and remembers them for edits and replies. */
  private push(id: string | undefined, parts: string[], opts: { keyboard?: Keyboard; silent?: boolean; card?: string; sig?: string }): void {
    const entry: Sent = { ids: [], sig: opts.sig ?? '', cardSig: opts.card };
    if (id) this.sent.set(id, entry);
    this.postedSinceStatus = true;
    this.enqueue(async () => {
      for (const [i, html] of parts.entries()) {
        const last = i === parts.length - 1;
        const msg = await this.sendHtml(html, { keyboard: last ? opts.keyboard : undefined, silent: opts.silent });
        entry.ids.push(msg.message_id);
        if (id) this.origin.set(msg.message_id, id);
      }
      if (opts.card) entry.card = (await this.sendHtml(opts.card, { silent: true })).message_id;
    });
  }

  private reply(html: string, opts: { keyboard?: Keyboard; silent?: boolean; replyTo?: number } = {}): Promise<void> {
    this.postedSinceStatus = true;
    this.enqueue(() => this.sendHtml(html, opts));
    return this.out;
  }

  /** Calls to Telegram go one at a time, in order; a failure is logged and doesn't hold up the rest. */
  private enqueue(fn: () => Promise<unknown>): void {
    this.out = this.out.then(() => fn().then(
      () => {},
      (e) => this.deps.log.error(`telegram: ${errorText(e)}`),
    ));
  }

  private async sendHtml(html: string, opts: { keyboard?: Keyboard; silent?: boolean; replyTo?: number }): Promise<TgMessage> {
    try {
      return await this.retry(() => this.deps.bot.send(this.chatId!, html, opts));
    } catch (e) {
      // Markdown the converter got wrong: plain text still gets the content through.
      if (!badMarkup(e)) throw e;
      return this.retry(() => this.deps.bot.send(this.chatId!, stripTags(html), opts));
    }
  }

  private async editHtml(messageId: number, html: string, keyboard?: Keyboard): Promise<void> {
    try {
      await this.retry(() => this.deps.bot.edit(this.chatId!, messageId, html, keyboard));
    } catch (e) {
      if (e instanceof TelegramError && /not modified/i.test(e.description)) return;
      if (!badMarkup(e)) throw e;
      await this.retry(() => this.deps.bot.edit(this.chatId!, messageId, stripTags(html), keyboard));
    }
  }

  /** Telegram's flood control answers 429 with how long to wait. */
  private async retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof TelegramError && e.code === 429) || attempt >= 3) throw e;
        await sleep((e.retryAfter ?? 3) * 1000);
      }
    }
  }

  private find(id: string | undefined): ChatMessage | undefined {
    return id ? this.deps.host.state().conversation.messages.find((m) => m.id === id) : undefined;
  }

  private workspace(): string {
    return this.deps.host.state().workspace ?? '—';
  }
}

// ---------- Helpers ----------

function settled(m: ChatMessage): boolean {
  return m.status !== 'streaming' && m.status !== 'routing';
}

/** What a finished message shows; a change (a verdict, a plan stripped later) means an edit. */
function signature(m: ChatMessage): string {
  return [m.status, messageText(m).length, m.error ?? '', m.teamStatus?.status ?? ''].join('|');
}

function planCard(m: ChatMessage): string | undefined {
  if (!m.plan?.length) return undefined;
  const ms = t().message;
  const done = m.plan.filter((x) => x.status === 'done').length;
  const title = m.kind === 'report' ? ms.nextIteration((m.iteration ?? 1) + 1) : ms.teamTasks;
  const lines = m.plan.map((task, i) => {
    const deps = task.dependsOn.map((d) => m.plan!.findIndex((x) => x.id === d) + 1).filter((n) => n > 0);
    return `${TASK_ICONS[task.status]} ${i + 1}. ${escapeHtml(task.title)} — ${AGENT_LABELS[task.agent]}${deps.length ? ` <i>(${ms.after(deps.join(', '))})</i>` : ''}`;
  });
  return [`📋 <b>${title}</b> · ${done}/${m.plan.length}`, ...lines].join('\n');
}

function limitsLine(a: AgentView): string {
  const l = t().limits;
  const left = (label: string, w?: LimitWindow | null) => {
    if (!w) return '';
    const used = w.resetsAt && w.resetsAt * 1000 < Date.now() ? 0 : w.usedPercent;
    return t().telegram.left(label, Math.round(100 - Math.min(100, Math.max(0, used))));
  };
  return [left(l.meterFiveHours, a.limits?.fiveHour), left(l.meterWeek, a.limits?.weekly)].filter(Boolean).join(' · ');
}

function settingName(name: Setting): string {
  const c = t().composer;
  return name === 'mode' ? c.mode : name === 'profile' ? c.profile : name === 'access' ? t().message.route.access : c.autopilot;
}

function settingLabel(name: Setting, value: string): string {
  const c = t().composer;
  if (name === 'mode') return c.modes[value as Prefs['mode']]?.label ?? value;
  if (name === 'profile') return c.profiles[value as Prefs['profile']]?.label ?? value;
  if (name === 'access') return c.autonomy[value as Prefs['autonomy']]?.label ?? value;
  return value === 'on' ? t().telegram.on : t().telegram.off;
}

function settingValue(p: Prefs, name: Setting): string {
  return name === 'mode' ? p.mode : name === 'profile' ? p.profile : name === 'access' ? p.autonomy : p.autopilot ? 'on' : 'off';
}

function agentAlias(s: string): AgentId | undefined {
  const name = s.replace(/^@/, '').toLowerCase();
  return parseMentions(`@${name}`).agents[0] ?? AGENT_IDS.find((id) => id.startsWith(name));
}

function isAgent(s: string): s is AgentId {
  return (AGENT_IDS as readonly string[]).includes(s);
}

function badMarkup(e: unknown): boolean {
  return e instanceof TelegramError && e.code === 400 && /parse entities|end tag|start tag|unsupported/i.test(e.description);
}

/** The text of our HTML with the tags dropped; entities stay escaped, which plain HTML mode accepts. */
function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
