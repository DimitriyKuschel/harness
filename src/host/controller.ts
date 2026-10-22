import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { ClaudeAdapter } from '../core/agents/claude';
import { CodexAdapter } from '../core/agents/codex';
import { GeminiAdapter } from '../core/agents/gemini';
import { Orchestrator, newConversation } from '../core/orchestrator';
import type { Logger } from '../core/proc';
import { Router, type RouterConfig } from '../core/router';
import {
  AGENT_IDS,
  AGENT_LABELS,
  type AgentAdapter,
  type AgentId,
  type AgentLimits,
  type AgentStatus,
  type Conversation,
  type Prefs,
  type ViewState,
} from '../core/types';
import type { ToHost, ToWebview } from '../protocol';
import { ConversationStore } from './store';
import { renderHtml } from './html';

const DEFAULT_PREFS: Prefs = { mode: 'auto', profile: 'balanced', autonomy: 'auto', autopilot: true };
/** Messages that start CLI runs; ignored in Restricted Mode. */
const RUNS_AGENTS = new Set<ToHost['type']>(['send', 'review', 'fix', 'rerun', 'debate', 'continueTeam']);
/** Quotas go stale when the CLIs are also used outside Harness, so they are re-read now and then (no model calls). */
const LIMITS_POLL_MS = 5 * 60_000;
const LIMITS_MIN_GAP_MS = 60_000;

export class Controller implements vscode.Disposable {
  private readonly adapters: Record<AgentId, AgentAdapter>;
  private readonly orch: Orchestrator;
  private readonly store: ConversationStore;
  private readonly webviews = new Set<vscode.Webview>();
  private readonly statusItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private statuses: Partial<Record<AgentId, AgentStatus>> = {};
  private limits: Partial<Record<AgentId, AgentLimits>>;
  private limitsReadAt: Partial<Record<AgentId, number>> = {};
  private readonly pollTimer: NodeJS.Timeout;
  private prefs: Prefs;
  private queue: { text: string; prefs: Prefs }[] = [];
  private panel?: vscode.WebviewPanel;
  private emitTimer?: NodeJS.Timeout;
  private saveTimer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: vscode.LogOutputChannel,
  ) {
    const logger: Logger = { info: (m) => log.info(m), error: (m) => log.error(m) };
    const cfg = () => vscode.workspace.getConfiguration('harness');
    this.adapters = {
      claude: new ClaudeAdapter(() => cfg().get('agents.claude.path') || 'claude', logger, () => cfg().get('agents.claude.chrome', false)),
      codex: new CodexAdapter(() => cfg().get('agents.codex.path') || 'codex', logger),
      gemini: new GeminiAdapter(() => cfg().get('agents.gemini.path') || 'agy', logger),
    };

    const scratch = vscode.Uri.joinPath(context.globalStorageUri, 'scratch').fsPath;
    mkdirSync(scratch, { recursive: true });
    const router = new Router(() => this.routerConfig(), this.adapters, () => scratch);

    this.store = new ConversationStore(context);
    this.limits = context.globalState.get('harness.limits', {});
    this.prefs = { ...DEFAULT_PREFS, ...context.globalState.get<Partial<Prefs>>('harness.prefs', {}) };

    this.orch = new Orchestrator({
      adapters: this.adapters,
      router,
      log: logger,
      cwd: () => this.cwd(),
      available: () => this.available(),
      limits: () => this.limits,
      onLimits: (agent, limits) => this.updateLimits(agent, limits),
      // Claude and Codex runs report quota themselves; agy runs don't.
      onRunEnd: (agent, startedAt) => {
        if ((this.limits[agent]?.updatedAt ?? 0) < startedAt) void this.refreshLimits([agent], true);
      },
      onChange: () => this.scheduleEmit(),
      onSettled: (conv) => this.onSettled(conv),
      maxIterations: () => vscode.workspace.getConfiguration('harness').get<number>('team.maxIterations', 5),
      maxHandoffs: () => vscode.workspace.getConfiguration('harness').get<number>('team.maxHandoffs', 6),
      hasQueued: () => this.queue.length > 0,
    });

    this.pollTimer = setInterval(() => {
      if (this.webviews.size) void this.refreshLimits();
    }, LIMITS_POLL_MS);
    this.pollTimer.unref?.();

    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusItem.command = 'harness.chat.focus';
    this.updateStatusItem();
    this.statusItem.show();

    this.disposables.push(
      this.statusItem,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('harness.agents')) void this.refreshAgents();
        else if (e.affectsConfiguration('harness')) this.scheduleEmit();
      }),
      // Agent paths are restricted settings: workspace values only apply once the folder is trusted.
      vscode.workspace.onDidGrantWorkspaceTrust(() => void this.refreshAgents()),
    );
  }

  async init(): Promise<void> {
    const lastId = this.store.lastId();
    const last = lastId ? await this.store.load(lastId) : undefined;
    if (last) this.orch.load(last);
    await this.refreshAgents();
    void this.refreshLimits();
  }

  async refreshAgents(): Promise<void> {
    const results = await Promise.all(AGENT_IDS.map((id) => this.adapters[id].detect()));
    for (const s of results) {
      this.statuses[s.id] = s;
      this.log.info(`${s.id}: ${s.installed ? `${s.version} (${s.path})` : `недоступен — ${s.error}`}`);
    }
    this.scheduleEmit();
  }

  /** Re-reads quotas through the CLIs; `force` skips the per-agent minimum gap. */
  async refreshLimits(ids: AgentId[] = this.available(), force = false): Promise<void> {
    const now = Date.now();
    await Promise.all(
      ids.map(async (id) => {
        const adapter = this.adapters[id];
        if (!adapter.readLimits || (!force && now - (this.limitsReadAt[id] ?? 0) < LIMITS_MIN_GAP_MS)) return;
        this.limitsReadAt[id] = now;
        const limits = await adapter.readLimits().catch((e) => {
          this.log.error(`${id}: не удалось прочитать лимиты — ${String(e)}`);
          return undefined;
        });
        if (limits) this.updateLimits(id, limits);
      }),
    );
  }

  // ---------- Webviews ----------

  attach(webview: vscode.Webview): vscode.Disposable {
    webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] };
    webview.html = renderHtml(webview, this.context.extensionUri);
    this.webviews.add(webview);
    const sub = webview.onDidReceiveMessage((m: ToHost) => this.handle(m).catch((e) => this.log.error(`handler: ${String(e)}`)));
    return new vscode.Disposable(() => {
      sub.dispose();
      this.webviews.delete(webview);
    });
  }

  openInEditor(): void {
    if (this.panel) return this.panel.reveal();
    const panel = vscode.window.createWebviewPanel('harness.panel', 'AI Team', vscode.ViewColumn.Beside, { retainContextWhenHidden: true });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'icon.svg');
    const detach = this.attach(panel.webview);
    panel.onDidDispose(() => {
      detach.dispose();
      this.panel = undefined;
    });
    this.panel = panel;
  }

  newChat(): void {
    if (this.orch.running) this.orch.stop();
    this.queue = [];
    this.orch.load(newConversation());
    void this.store.setLast(undefined);
  }

  private async handle(m: ToHost): Promise<void> {
    if (!vscode.workspace.isTrusted && RUNS_AGENTS.has(m.type)) return this.emit();
    switch (m.type) {
      case 'ready':
        void this.refreshLimits();
        return this.emit();
      case 'send':
        this.setPrefs(m.prefs);
        if (!m.text.trim()) return;
        if (this.orch.running) {
          this.queue.push({ text: m.text, prefs: m.prefs });
          return this.scheduleEmit();
        }
        return this.orch.send(m.text, m.prefs);
      case 'stop':
        this.queue = [];
        return this.orch.stop();
      case 'prefs':
        return this.setPrefs(m.prefs);
      case 'newChat':
        return this.newChat();
      case 'openChat': {
        const conv = await this.store.load(m.id);
        if (!conv) return void vscode.window.showWarningMessage('Чат не найден.');
        this.queue = [];
        this.orch.load(conv);
        return this.store.setLast(conv.id);
      }
      case 'deleteChat':
        await this.store.remove(m.id);
        if (this.orch.conversation.id === m.id) this.newChat();
        return this.scheduleEmit();
      case 'review':
        return this.orch.review(m.id, this.prefs);
      case 'fix':
        return this.orch.fix(m.id, this.prefs);
      case 'rerun':
        return this.orch.rerun(m.id, this.prefs, m.stronger);
      case 'debate':
        return this.orch.debate(m.round, this.prefs);
      case 'continueTeam':
        return this.orch.continueTeam(m.id, this.prefs);
      case 'unqueue':
        this.queue.splice(m.index, 1);
        return this.scheduleEmit();
      case 'openFile':
        return this.openFile(m.path);
      case 'openLink':
        if (/^https?:\/\//.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case 'copy':
        return vscode.env.clipboard.writeText(m.text);
      case 'command':
        if (m.command === 'settings') await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:korsar.harness');
        if (m.command === 'refresh') await this.refreshAgents();
        if (m.command === 'limits' || m.command === 'refresh') await this.refreshLimits(this.available(), true);
        if (m.command === 'log') this.log.show();
        if (m.command === 'trust') await vscode.commands.executeCommand('workbench.trust.manage');
        return;
    }
  }

  private scheduleEmit(): void {
    this.updateStatusItem();
    if (this.emitTimer) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = undefined;
      this.emit();
    }, 50);
  }

  private emit(): void {
    const msg: ToWebview = { type: 'state', state: this.viewState() };
    for (const w of this.webviews) void w.postMessage(msg);
  }

  private viewState(): ViewState {
    const busy = this.orch.busyAgents();
    return {
      conversation: this.orch.conversation,
      history: this.store.list(),
      agents: AGENT_IDS.map((id) => ({
        id,
        label: AGENT_LABELS[id],
        installed: !!this.statuses[id]?.installed,
        enabled: this.isEnabled(id),
        version: this.statuses[id]?.version,
        error: this.statuses[id]?.error,
        limits: this.limits[id],
        busy: busy.has(id),
      })),
      running: this.orch.running,
      queue: this.queue.map((q) => q.text),
      prefs: this.prefs,
      workspace: vscode.workspace.workspaceFolders?.[0]?.name,
      trusted: vscode.workspace.isTrusted,
    };
  }

  // ---------- State ----------

  private onSettled(conv: Conversation): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.store.save(conv).then(() => this.scheduleEmit()), 300);
    if (!this.orch.running && this.queue.length) {
      const next = this.queue.shift()!;
      void this.orch.send(next.text, next.prefs);
    }
  }

  private setPrefs(p: Prefs): void {
    this.prefs = p;
    void this.context.globalState.update('harness.prefs', p);
  }

  private updateLimits(agent: AgentId, l: AgentLimits): void {
    // Claude's stream may report one window at a time; keep the other. `null` (no such window) does replace.
    this.limits[agent] = { ...this.limits[agent], ...Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined)) } as AgentLimits;
    void this.context.globalState.update('harness.limits', this.limits);
    this.scheduleEmit();
  }

  private isEnabled(id: AgentId): boolean {
    return vscode.workspace.getConfiguration('harness').get<boolean>(`agents.${id}.enabled`, true);
  }

  private available(): AgentId[] {
    return AGENT_IDS.filter((id) => this.isEnabled(id) && this.statuses[id]?.installed);
  }

  private cwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? homedir();
  }

  private routerConfig(): RouterConfig {
    const cfg = vscode.workspace.getConfiguration('harness');
    return {
      classifier: cfg.get('routing.classifier', 'llm'),
      affinity: merged(cfg, 'routing.affinity'),
      models: merged(cfg, 'models'),
      strengths: merged(cfg, 'strengths'),
    };
  }

  private updateStatusItem(): void {
    const busy = [...this.orch.busyAgents()].map((a) => AGENT_LABELS[a]);
    this.statusItem.text = busy.length ? `$(sync~spin) ${busy.join(', ')}` : '$(organization) AI Team';
    this.statusItem.tooltip = busy.length ? 'Команда работает — открыть чат' : 'Открыть чат команды';
  }

  private async openFile(ref: string): Promise<void> {
    const m = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(ref.trim());
    const file = m?.[1] ?? ref;
    const line = m?.[2] ? Math.max(0, Number(m[2]) - 1) : undefined;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    let uri: vscode.Uri | undefined = isAbsolute(file) ? vscode.Uri.file(file) : root && vscode.Uri.joinPath(root, file);
    if (uri && !(await exists(uri))) uri = undefined;
    if (!uri && !isAbsolute(file)) {
      const found = await vscode.workspace.findFiles(`**/${file.replace(/^\.?\//, '')}`, '**/node_modules/**', 1);
      uri = found[0];
    }
    if (!uri) return void vscode.window.showWarningMessage(`Файл не найден: ${file}`);
    const selection = line !== undefined ? new vscode.Range(line, 0, line, 0) : undefined;
    await vscode.window.showTextDocument(uri, {
      preview: true,
      selection,
      viewColumn: this.panel?.active ? vscode.ViewColumn.Beside : vscode.ViewColumn.Active,
    });
  }

  dispose(): void {
    this.orch.stop();
    clearTimeout(this.emitTimer);
    clearTimeout(this.saveTimer);
    clearInterval(this.pollTimer);
    void this.store.save(this.orch.conversation);
    for (const d of this.disposables) d.dispose();
  }
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** Object settings: user values deep-merged over defaults, so a partial override keeps the rest. */
function merged<T>(cfg: vscode.WorkspaceConfiguration, key: string): T {
  const i = cfg.inspect<object>(key);
  return [i?.globalValue, i?.workspaceValue, i?.workspaceFolderValue].reduce<object>((acc, v) => deepMerge(acc, v), i?.defaultValue ?? {}) as T;
}

function deepMerge(base: any, over: any): any {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out: any = { ...(base ?? {}) };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
}
