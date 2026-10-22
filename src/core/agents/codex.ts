import { open, readdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter, AgentEvent, AgentLimits, AgentStatus, LimitWindow, RunOutcome, RunRequest, Usage } from '../types';
import { type Logger, nullLogger, resolveBinary, runJsonl, runText, truncate, tryParseJson } from '../proc';
import { shortPath } from './claude';

/** Drives the official `codex` binary via `codex exec --json`. */
export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex' as const;

  constructor(
    private readonly binary: () => string,
    private readonly log: Logger = nullLogger,
  ) {}

  async detect(): Promise<AgentStatus> {
    const path = await resolveBinary(this.binary());
    if (!path) return { id: this.id, installed: false, error: `«${this.binary()}» не найден` };
    try {
      const version = (await runText(path, ['--version'])).replace(/^codex-cli\s*/, '');
      return { id: this.id, installed: true, version, path };
    } catch (e) {
      return { id: this.id, installed: false, path, error: String(e) };
    }
  }

  async run(req: RunRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<RunOutcome> {
    const path = (await resolveBinary(this.binary())) ?? this.binary();
    const args = ['exec'];
    if (req.sessionId) args.push('resume', req.sessionId);
    args.push('--json', '--skip-git-repo-check');
    if (req.model) args.push('-m', req.model);
    if (req.effort) args.push('-c', `model_reasoning_effort="${req.effort}"`);
    if (req.ephemeral) args.push('--ephemeral');

    const autonomy = req.ephemeral ? 'readonly' : req.autonomy;
    if (autonomy === 'readonly') {
      // No escalation requests: with `approvals_reviewer = "auto_review"` in the user's config they get auto-approved
      // and the command runs outside the sandbox.
      args.push('-c', 'sandbox_mode="read-only"', '-c', 'approval_policy="never"');
    } else if (autonomy === 'auto') {
      args.push('-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true');
    } else {
      args.push('-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"');
    }

    let schemaFile: string | undefined;
    if (req.jsonSchema && !req.sessionId) {
      schemaFile = join(tmpdir(), `harness-schema-${process.pid}-${Date.now()}.json`);
      await writeFile(schemaFile, JSON.stringify(req.jsonSchema));
      args.push('--output-schema', schemaFile);
    }
    args.push('-');

    // Codex has no "append system prompt" flag: new threads get the brief inline.
    const prompt = !req.sessionId && req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n${req.prompt}` : req.prompt;

    const state = new CodexStream(req.cwd, onEvent);
    try {
      const res = await runJsonl(path, args, { cwd: req.cwd, stdin: prompt, signal, log: this.log }, (line) =>
        state.handle(tryParseJson(line)),
      );
      const sessionId = state.threadId ?? req.sessionId;

      if (sessionId && !req.ephemeral) {
        const limits = await readCodexLimits(sessionId).catch(() => undefined);
        if (limits) onEvent({ kind: 'limits', limits });
      }

      if (res.aborted) return { ok: false, text: state.text, sessionId, error: 'остановлено' };
      if (state.failure || (res.code !== 0 && !state.completed)) {
        const error = state.failure ?? (res.stderr.trim().split('\n').slice(-3).join('\n') || `codex завершился с кодом ${res.code}`);
        return { ok: false, text: state.text, sessionId, error, usage: state.usage };
      }
      let structured: unknown;
      if (req.jsonSchema) structured = tryParseJson(state.lastMessage.trim());
      return { ok: true, text: state.text, sessionId, structured, usage: state.usage };
    } finally {
      if (schemaFile) await rm(schemaFile, { force: true });
    }
  }

  /** Live quota from the app server; the newest session log if that fails. */
  async readLimits(): Promise<AgentLimits | undefined> {
    const path = await resolveBinary(this.binary());
    const live = path ? await readAppServerLimits(path).catch(() => undefined) : undefined;
    return live ?? readLatestCodexLimits();
  }
}

class CodexStream {
  threadId?: string;
  usage?: Usage;
  failure?: string;
  completed = false;
  text = '';
  lastMessage = '';
  private messageText = new Map<string, string>();
  private startedTools = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly emit: (e: AgentEvent) => void,
  ) {}

  handle(ev: any): void {
    if (!ev || typeof ev !== 'object') return;
    switch (ev.type) {
      case 'thread.started':
        this.threadId = ev.thread_id;
        this.emit({ kind: 'session', id: ev.thread_id });
        break;
      case 'item.started':
      case 'item.updated':
      case 'item.completed':
        this.handleItem(ev.item ?? {}, ev.type === 'item.completed');
        break;
      case 'turn.completed':
        this.completed = true;
        if (ev.usage) {
          this.usage = { input: ev.usage.input_tokens ?? 0, output: ev.usage.output_tokens ?? 0, cached: ev.usage.cached_input_tokens ?? 0 };
          this.emit({ kind: 'usage', usage: this.usage });
        }
        break;
      case 'turn.failed':
        this.failure = ev.error?.message ?? 'ход завершился ошибкой';
        break;
      case 'error':
        this.failure = ev.message ?? 'ошибка codex';
        break;
    }
  }

  private handleItem(item: any, completed: boolean): void {
    const id = String(item.id ?? '');
    switch (item.type) {
      case 'agent_message': {
        const full = String(item.text ?? '');
        const prev = this.messageText.get(id);
        if (prev === undefined) {
          if (!full) return;
          const newBlock = this.text.length > 0;
          this.text += (newBlock ? '\n\n' : '') + full;
          this.emit({ kind: 'text', delta: full, newBlock });
        } else if (full.startsWith(prev) && full.length > prev.length) {
          const delta = full.slice(prev.length);
          this.text += delta;
          this.emit({ kind: 'text', delta });
        }
        this.messageText.set(id, full);
        if (completed) this.lastMessage = full;
        break;
      }
      case 'command_execution':
        this.tool(id, 'Shell', truncate(String(item.command ?? ''), 140));
        if (completed) this.emit({ kind: 'tool_done', id, ok: item.exit_code === 0 || item.status === 'completed' });
        break;
      case 'file_change': {
        const paths = (item.changes ?? []).map((c: any) => shortPath(String(c.path ?? ''), this.cwd));
        this.tool(id, 'Edit', truncate(paths.join(', '), 140));
        if (completed) this.emit({ kind: 'tool_done', id, ok: item.status !== 'failed' });
        break;
      }
      case 'mcp_tool_call':
        this.tool(id, `${item.server ?? 'mcp'}.${item.tool ?? ''}`);
        if (completed) this.emit({ kind: 'tool_done', id, ok: item.status !== 'failed' });
        break;
      case 'web_search':
        this.tool(id, 'WebSearch', truncate(String(item.query ?? ''), 140));
        if (completed) this.emit({ kind: 'tool_done', id, ok: true });
        break;
      case 'todo_list':
        this.tool(id, 'Plan', Array.isArray(item.items) ? `${item.items.length} пунктов` : undefined);
        if (completed) this.emit({ kind: 'tool_done', id, ok: true });
        break;
    }
  }

  private tool(id: string, name: string, detail?: string): void {
    if (this.startedTools.has(id)) return;
    this.startedTools.add(id);
    this.emit({ kind: 'tool', id, name, detail });
  }
}

/**
 * `codex exec --json` doesn't report quota, but the session rollout file logs
 * `rate_limits` with every token_count event. Read the newest one.
 */
export async function readCodexLimits(threadId: string): Promise<AgentLimits | undefined> {
  const file = await findRollout(threadId);
  return file ? limitsFromRollout(file) : undefined;
}

async function limitsFromRollout(file: string): Promise<AgentLimits | undefined> {
  const tail = await readTail(file, 256 * 1024);
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"rate_limits"')) continue;
    const rl = tryParseJson(lines[i])?.payload?.rate_limits;
    if (rl) return parseCodexRateLimits(rl);
  }
  return undefined;
}

/** Quota snapshot from the most recent Codex session on this machine (any client). */
export async function readLatestCodexLimits(): Promise<AgentLimits | undefined> {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  for (let back = 0; back < 7; back++) {
    const d = new Date(Date.now() - back * 86_400_000);
    const dir = join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith('.jsonl')).sort().reverse();
    for (const name of names.slice(0, 5)) {
      const limits = await limitsFromRollout(join(dir, name)).catch(() => undefined);
      if (limits) return limits;
    }
  }
  return undefined;
}

/** A full snapshot: `codex app-server` answers in camelCase, rollout files use snake_case. */
export function parseCodexRateLimits(rl: any): AgentLimits | undefined {
  const out: AgentLimits = { fiveHour: null, weekly: null, updatedAt: Date.now() };
  for (const w of [rl?.primary, rl?.secondary]) {
    const used = w?.usedPercent ?? w?.used_percent;
    if (typeof used !== 'number') continue;
    const win: LimitWindow = { usedPercent: used, resetsAt: w.resetsAt ?? w.resets_at };
    if ((w.windowDurationMins ?? w.window_minutes) <= 6 * 60) out.fiveHour = win;
    else out.weekly = win;
  }
  return out.fiveHour || out.weekly ? out : undefined;
}

/** The account's live quota from `codex app-server` (JSON-RPC over stdio, no model call). */
async function readAppServerLimits(path: string): Promise<AgentLimits | undefined> {
  const requests = [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'harness', version: '0.1.0' } } },
    { method: 'initialized' },
    { id: 2, method: 'account/rateLimits/read' },
  ];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 20_000);
  let limits: AgentLimits | undefined;
  try {
    // The server quits on EOF before answering, so stdin stays open until the reply arrives.
    const stdin = requests.map((r) => JSON.stringify({ jsonrpc: '2.0', ...r })).join('\n') + '\n';
    await runJsonl(path, ['app-server'], { cwd: homedir(), stdin, holdStdin: true, signal: ac.signal }, (line) => {
      const m = tryParseJson(line);
      if (m?.id !== 2) return;
      limits = parseCodexRateLimits(m.result?.rateLimits);
      ac.abort();
    });
  } finally {
    clearTimeout(timer);
  }
  return limits;
}

async function findRollout(threadId: string): Promise<string | undefined> {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions');
  // Rollouts live in sessions/YYYY/MM/DD; a resumed thread may be from an older day.
  for (let back = 0; back < 14; back++) {
    const d = new Date(Date.now() - back * 86_400_000);
    const dir = join(root, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
    const names = await readdir(dir).catch(() => [] as string[]);
    const hit = names.find((n) => n.endsWith(`${threadId}.jsonl`));
    if (hit) return join(dir, hit);
  }
  return undefined;
}

async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally {
    await fh.close();
  }
}

const pad = (n: number) => String(n).padStart(2, '0');
