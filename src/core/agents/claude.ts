import { homedir } from 'node:os';
import { relative, isAbsolute } from 'node:path';
import { t } from '../../i18n';
import { prompts } from '../prompts';
import type { AgentAdapter, AgentEvent, AgentLimits, AgentStatus, LimitWindow, RunOutcome, RunRequest, Usage } from '../types';
import { type Logger, nullLogger, resolveBinary, runJsonl, runText, truncate, tryParseJson } from '../proc';

const READONLY_COMMANDS = ['git status', 'git diff', 'git log', 'git show', 'git branch', 'ls', 'find', 'cat', 'head', 'tail', 'wc', 'rg', 'grep', 'tree', 'pwd'];
// Opening and reading pages only: clicks, typing and page scripts would act in the user's signed-in Chrome.
const READONLY_BROWSER = ['tabs_context_mcp', 'tabs_create_mcp', 'navigate', 'get_page_text', 'read_page', 'find', 'read_console_messages', 'read_network_requests'];
const READONLY_TOOLS = [
  'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch',
  ...READONLY_COMMANDS.map((c) => `Bash(${c}:*)`),
  ...READONLY_BROWSER.map((t) => `mcp__claude-in-chrome__${t}`),
];

// Allow rules match a whole command line, so `cd x && git diff` is denied even though `git diff` alone is allowed.
const readonlyHint = (browser: boolean) => prompts().readonlyClaude(READONLY_COMMANDS.join(', '), browser);

/** Drives the official `claude` binary in print mode with stream-json output. */
export class ClaudeAdapter implements AgentAdapter {
  readonly id = 'claude' as const;

  constructor(
    private readonly binary: () => string,
    private readonly log: Logger = nullLogger,
    private readonly chrome: () => boolean = () => false,
  ) {}

  async detect(): Promise<AgentStatus> {
    const path = await resolveBinary(this.binary());
    if (!path) return { id: this.id, installed: false, error: t().cli.notFound(this.binary()) };
    try {
      const version = (await runText(path, ['--version'])).split(/\s/)[0];
      return { id: this.id, installed: true, version, path };
    } catch (e) {
      return { id: this.id, installed: false, path, error: String(e) };
    }
  }

  async run(req: RunRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<RunOutcome> {
    const path = (await resolveBinary(this.binary())) ?? this.binary();
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
    if (req.model) args.push('--model', req.model);
    if (req.effort) args.push('--effort', req.effort);
    if (req.sessionId) args.push('--resume', req.sessionId);
    else if (req.systemPrompt) args.push('--append-system-prompt', req.systemPrompt);
    if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));

    // Print mode leaves Claude in Chrome off even when it is enabled by default for interactive sessions.
    const chrome = !req.ephemeral && this.chrome();
    if (chrome) args.push('--chrome');

    if (req.ephemeral) {
      args.push('--tools', '', '--strict-mcp-config', '--no-session-persistence');
    } else if (req.autonomy === 'readonly') {
      args.push('--permission-mode', 'dontAsk', '--allowedTools', ...READONLY_TOOLS);
    } else if (req.autonomy === 'auto') {
      args.push('--permission-mode', 'auto');
    } else {
      args.push('--permission-mode', 'bypassPermissions');
    }

    const prompt = req.autonomy === 'readonly' && !req.ephemeral ? req.prompt + readonlyHint(chrome) : req.prompt;
    const state = new StreamState(req.cwd, onEvent);
    const res = await runJsonl(path, args, { cwd: req.cwd, stdin: prompt, signal, log: this.log }, (line) =>
      state.handle(tryParseJson(line)),
    );

    if (res.aborted) return { ok: false, text: state.text, sessionId: state.sessionId, error: t().cli.stopped };
    const r = state.result;
    if (r && !r.is_error && r.subtype === 'success') {
      return {
        ok: true,
        text: typeof r.result === 'string' ? r.result : state.text,
        sessionId: state.sessionId,
        structured: r.structured_output,
        usage: state.usage,
      };
    }
    const error =
      (r && (typeof r.result === 'string' && r.is_error ? r.result : r.subtype)) ||
      lastLines(res.stderr) ||
      t().cli.exited('claude', res.code);
    return { ok: false, text: state.text, sessionId: state.sessionId, error, usage: state.usage };
  }

  /** `/usage` is answered locally in print mode, without a model call. */
  async readLimits(): Promise<AgentLimits | undefined> {
    const path = await resolveBinary(this.binary());
    if (!path) return undefined;
    const out = await runText(path, ['-p', '/usage', '--output-format', 'json', '--no-session-persistence', '--strict-mcp-config'], 30_000);
    const r = tryParseJson(out);
    return typeof r?.result === 'string' ? parseClaudeUsage(r.result) : undefined;
  }
}

class StreamState {
  sessionId?: string;
  result?: any;
  usage?: Usage;
  text = '';
  private streamedMessages = new Set<string>();
  private currentMessage?: string;
  private emittedText = false;
  private pendingNewBlock = false;

  constructor(
    private readonly cwd: string,
    private readonly emit: (e: AgentEvent) => void,
  ) {}

  handle(ev: any): void {
    if (!ev || typeof ev !== 'object') return;
    // Events from sub-agents (Task tool) carry a parent id; keep the top-level story only.
    if (ev.parent_tool_use_id) return;

    switch (ev.type) {
      case 'system':
        if (ev.subtype === 'init') {
          if (ev.session_id) this.setSession(ev.session_id);
          if (ev.model) this.emit({ kind: 'model', model: ev.model });
        }
        break;

      case 'stream_event':
        this.handleStreamEvent(ev.event);
        break;

      case 'assistant': {
        const msg = ev.message ?? {};
        const streamed = msg.id && this.streamedMessages.has(msg.id);
        for (const block of msg.content ?? []) {
          if (block.type === 'text' && !streamed && block.text) {
            this.pushText(block.text, true);
          } else if (block.type === 'tool_use') {
            this.emit({ kind: 'tool', id: block.id, name: block.name, detail: describeTool(block.name, block.input, this.cwd) });
          }
        }
        break;
      }

      case 'user': {
        const content = ev.message?.content;
        if (!Array.isArray(content)) break;
        for (const block of content) {
          if (block.type === 'tool_result') this.emit({ kind: 'tool_done', id: block.tool_use_id, ok: !block.is_error });
        }
        break;
      }

      case 'rate_limit_event': {
        const limits = parseClaudeLimits(ev.rate_limit_info);
        if (limits) this.emit({ kind: 'limits', limits });
        break;
      }

      case 'result':
        this.result = ev;
        if (ev.session_id) this.setSession(ev.session_id);
        if (ev.usage) {
          this.usage = {
            input: (ev.usage.input_tokens ?? 0) + (ev.usage.cache_creation_input_tokens ?? 0) + (ev.usage.cache_read_input_tokens ?? 0),
            output: ev.usage.output_tokens ?? 0,
            cached: ev.usage.cache_read_input_tokens ?? 0,
          };
          this.emit({ kind: 'usage', usage: this.usage });
        }
        break;
    }
  }

  private handleStreamEvent(se: any): void {
    if (!se) return;
    if (se.type === 'message_start') {
      this.currentMessage = se.message?.id;
    } else if (se.type === 'content_block_start' && se.content_block?.type === 'text') {
      this.pendingNewBlock = true;
    } else if (se.type === 'content_block_delta' && se.delta?.type === 'text_delta' && se.delta.text) {
      if (this.currentMessage) this.streamedMessages.add(this.currentMessage);
      this.pushText(se.delta.text, this.pendingNewBlock);
      this.pendingNewBlock = false;
    }
  }

  private pushText(delta: string, newBlock: boolean): void {
    const sep = newBlock && this.emittedText ? '\n\n' : '';
    this.text += sep + delta;
    this.emit({ kind: 'text', delta, newBlock: newBlock && this.emittedText });
    this.emittedText = true;
  }

  private setSession(id: string): void {
    if (this.sessionId === id) return;
    this.sessionId = id;
    this.emit({ kind: 'session', id });
  }
}

export function parseClaudeLimits(info: any): AgentLimits | undefined {
  if (!info) return undefined;
  const toWindow = (w: any) =>
    w && typeof w.utilization === 'number' ? { usedPercent: w.utilization * 100, resetsAt: w.resetsAt } : undefined;
  const windows = info.unifiedWindows;
  if (windows) {
    return { fiveHour: toWindow(windows.five_hour), weekly: toWindow(windows.seven_day), updatedAt: Date.now() };
  }
  if (typeof info.utilization === 'number') {
    const w = toWindow(info);
    if (info.rateLimitType === 'five_hour') return { fiveHour: w, updatedAt: Date.now() };
    if (info.rateLimitType?.startsWith('seven_day')) return { weekly: w, updatedAt: Date.now() };
  }
  return undefined;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** The text of `/usage`: "Current session: 41% used · resets Oct 18, 10:50pm (UTC)". */
export function parseClaudeUsage(text: string, now = new Date()): AgentLimits | undefined {
  const window = (label: string): LimitWindow | undefined => {
    const m = new RegExp(`${label}:\\s*(\\d+(?:\\.\\d+)?)%\\s*used(?:\\s*·\\s*resets\\s+([^(\\n]+))?`, 'i').exec(text);
    return m ? { usedPercent: Number(m[1]), resetsAt: m[2] ? parseResetTime(m[2].trim(), now) : undefined } : undefined;
  };
  const out: AgentLimits = { fiveHour: window('Current session'), weekly: window('Current week \\(all models\\)'), updatedAt: now.getTime() };
  return out.fiveHour || out.weekly ? out : undefined;
}

/** "Oct 18, 10:50pm" or "1pm", in the machine's time zone (the CLI prints local time) → unix seconds. */
function parseResetTime(s: string, now: Date): number | undefined {
  const m = /^(?:([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i.exec(s);
  const month = m?.[1] ? MONTHS.indexOf(m[1].toLowerCase()) : now.getMonth();
  if (!m || month < 0) return undefined;
  const hour = (Number(m[3]) % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  const d = new Date(now.getFullYear(), month, m[2] ? Number(m[2]) : now.getDate(), hour, Number(m[4] ?? 0));
  // Resets lie ahead: "Jan 2" seen in late December is next year.
  if (d.getTime() < now.getTime() - 86_400_000) d.setFullYear(d.getFullYear() + 1);
  return Math.floor(d.getTime() / 1000);
}

export function describeTool(name: string, input: any, cwd: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const rel = (p: unknown) => (typeof p === 'string' ? shortPath(p, cwd) : undefined);
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return rel(input.file_path ?? input.notebook_path);
    case 'Bash':
      return truncate(String(input.command ?? ''), 140);
    case 'Grep':
      return truncate(input.path ? t().cli.inPath(input.pattern ?? '', rel(input.path)!) : String(input.pattern ?? ''), 140);
    case 'Glob':
      return truncate(String(input.pattern ?? ''), 140);
    case 'WebSearch':
      return truncate(String(input.query ?? ''), 140);
    case 'WebFetch':
      return truncate(String(input.url ?? ''), 140);
    case 'Task':
    case 'Agent':
      return truncate(String(input.description ?? input.prompt ?? ''), 140);
    case 'TodoWrite':
      return Array.isArray(input.todos) ? t().cli.items(input.todos.length) : undefined;
    default:
      return truncate(JSON.stringify(input), 140);
  }
}

export function shortPath(p: string, cwd: string): string {
  if (!isAbsolute(p)) return p;
  const r = relative(cwd, p);
  if (!r.startsWith('..')) return r || '.';
  const home = homedir();
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function lastLines(s: string): string {
  return s.trim().split('\n').slice(-3).join('\n');
}
