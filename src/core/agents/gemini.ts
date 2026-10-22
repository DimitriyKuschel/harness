import type { AgentAdapter, AgentEvent, AgentLimits, AgentStatus, LimitWindow, RunOutcome, RunRequest, Usage } from '../types';
import { type Logger, nullLogger, resolveBinary, runJsonl, runText, truncate, tryParseJson } from '../proc';
import { shortPath } from './claude';

/** Linux caps a single argv string at 128 KiB, and `agy -p` only takes the prompt as an argument. */
const MAX_PROMPT_BYTES = 120_000;
const EFFORT_IN_SLUG = /-(low|medium|high)$/;
// Read-only = plan mode without auto-approval: shell commands are denied (--sandbox does not stop
// `echo > file` in the workspace). Plan mode also nudges the agent towards plan artifacts, hence the hint.
const READONLY_HINT =
  '\n\n(Режим только чтения: shell-команды запрещены — изучай проект инструментами просмотра файлов, списка папок и поиска. Отвечай прямо здесь, текстом в чате; не создавай планы, артефакты и файлы.)';

/**
 * Drives the official Antigravity CLI: `agy -p <prompt> --output-format stream-json`.
 * Events look like {"event":"init"|"step_update"|"result", <event>: {...}}.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly id = 'gemini' as const;

  constructor(
    private readonly binary: () => string,
    private readonly log: Logger = nullLogger,
  ) {}

  async detect(): Promise<AgentStatus> {
    const path = await resolveBinary(this.binary());
    if (!path) return { id: this.id, installed: false, error: 'Antigravity CLI (agy) не установлен' };
    try {
      const version = (await runText(path, ['--version'])).split(/\s/).pop();
      return { id: this.id, installed: true, version, path };
    } catch (e) {
      return { id: this.id, installed: false, path, error: String(e) };
    }
  }

  async run(req: RunRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<RunOutcome> {
    const path = (await resolveBinary(this.binary())) ?? this.binary();
    const autonomy = req.ephemeral ? 'readonly' : req.autonomy;
    const brief = !req.sessionId && req.systemPrompt ? `${req.systemPrompt}\n\n---\n\n` : '';
    const full = brief + req.prompt + (autonomy === 'readonly' ? READONLY_HINT : '');
    const args = ['-p', fitPrompt(full), '--output-format', 'stream-json'];
    if (req.model) args.push('--model', req.model);
    // Antigravity model slugs carry the effort ("gemini-4-argon-high"); only pass --effort for bare slugs.
    if (req.effort && !(req.model && EFFORT_IN_SLUG.test(req.model))) args.push('--effort', req.effort);
    if (req.sessionId) args.push('--conversation', req.sessionId);
    if (req.jsonSchema) args.push('--json-schema', JSON.stringify(req.jsonSchema));

    // Print mode can't ask for permission: anything that would prompt is denied.
    // `--mode plan` is silently ignored together with --disable-slash-commands, so that flag is
    // only used when plan mode isn't needed (our prompts never start with "/" anyway).
    if (autonomy === 'readonly') args.push('--mode', 'plan');
    else if (autonomy === 'auto') args.push('--dangerously-skip-permissions', '--sandbox', '--disable-slash-commands');
    else args.push('--dangerously-skip-permissions', '--disable-slash-commands');

    const s = new GeminiStream(req.cwd, onEvent);
    const res = await runJsonl(path, args, { cwd: req.cwd, signal, log: this.log }, (line) => s.handle(tryParseJson(line)));
    const sessionId = s.conversationId ?? req.sessionId;
    if (res.aborted) return { ok: false, text: s.text, sessionId, error: 'остановлено' };

    const r = s.result;
    const response = typeof r?.response === 'string' ? r.response.trim() : '';
    const text = s.text.trim() || response;
    if (r?.status === 'SUCCESS' && text) {
      return { ok: true, text, sessionId, structured: r.structured_output ?? (req.jsonSchema ? tryParseJson(response) : undefined), usage: s.usage };
    }
    const denied: string[] = (r?.denied_actions ?? []).map((d: any) => d.display_name ?? d.action).filter(Boolean);
    const stderr = res.stderr.trim().split('\n').filter((l) => l.trim()).slice(-2).join('\n');
    const reported = typeof r?.error === 'string' ? r.error : r?.error?.message;
    const error =
      reported ||
      (denied.length ? `Нет разрешения на: ${denied.join(', ')} — попробуйте режим «Правки»` : '') ||
      stderr ||
      (r ? `agy: ${r.status ?? 'пустой ответ'}` : `agy завершился с кодом ${res.code}`);
    return { ok: false, text, sessionId, usage: s.usage, error };
  }

  /** `/usage` is answered locally in print mode, without a model call. */
  async readLimits(): Promise<AgentLimits | undefined> {
    const path = await resolveBinary(this.binary());
    if (!path) return undefined;
    return parseAgyUsage(tryParseJson(await runText(path, ['-p', '/usage', '--output-format', 'json'], 30_000)));
  }
}

/**
 * `agy -p /usage --output-format json`: quota per model group, each with a weekly and a 5-hour bucket.
 * We run Gemini models, so their group is the one that matters.
 */
export function parseAgyUsage(r: any): AgentLimits | undefined {
  const groups: any[] = r?.command?.data?.groups ?? [];
  const group = groups.find((g) => g?.buckets?.some((b: any) => String(b?.id).startsWith('gemini'))) ?? groups.find((g) => /gemini/i.test(g?.name));
  const out: AgentLimits = { updatedAt: Date.now() };
  for (const b of group?.buckets ?? []) {
    if (typeof b?.remaining_fraction !== 'number') continue;
    const reset = Date.parse(b.reset_time);
    const win: LimitWindow = { usedPercent: (1 - b.remaining_fraction) * 100, resetsAt: Number.isNaN(reset) ? undefined : Math.floor(reset / 1000) };
    if (b.window === '5h') out.fiveHour = win;
    else if (b.window === 'weekly') out.weekly = win;
  }
  return out.fiveHour || out.weekly ? out : undefined;
}

class GeminiStream {
  conversationId?: string;
  result?: any;
  usage?: Usage;
  text = '';
  private lastTextStep = -1;
  private tools = new Set<string>();

  constructor(
    private readonly cwd: string,
    private readonly emit: (e: AgentEvent) => void,
  ) {}

  handle(ev: any): void {
    if (!ev || typeof ev !== 'object') return;
    const body = ev[ev.event] ?? {};
    const conv = ev.conversation_id ?? body.conversation_id;
    if (conv && conv !== this.conversationId) {
      this.conversationId = conv;
      this.emit({ kind: 'session', id: conv });
    }

    if (ev.event === 'init') {
      if (body.model) this.emit({ kind: 'model', model: body.model });
    } else if (ev.event === 'step_update') {
      this.step(body);
    } else if (ev.event === 'result') {
      this.result = body;
      const u = body.usage;
      if (u) {
        this.usage = { input: (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0), output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0), cached: u.cache_read_tokens ?? 0 };
        this.emit({ kind: 'usage', usage: this.usage });
      }
    }
  }

  private step(b: any): void {
    const id = `step-${b.step_index}`;
    if (b.step_type === 'agent_response' && typeof b.text_delta === 'string' && b.text_delta) {
      const newBlock = b.step_index !== this.lastTextStep && this.text.trim().length > 0;
      // Don't open the answer with a bare "\n" (steps end with one).
      const delta = this.text || b.text_delta.trim() ? b.text_delta : '';
      if (!delta) return;
      this.text += (newBlock ? '\n\n' : '') + delta;
      this.lastTextStep = b.step_index;
      this.emit({ kind: 'text', delta, newBlock });
    } else if (b.step_type === 'tool') {
      if (!this.tools.has(id)) {
        this.tools.add(id);
        this.emit({ kind: 'tool', id, name: b.tool_name ?? b.tool_info?.name ?? 'tool', detail: describe(b.tool_info?.parameters, this.cwd) });
      }
      if (b.state && b.state !== 'ACTIVE') this.emit({ kind: 'tool_done', id, ok: b.state === 'DONE' });
    }
  }
}

function describe(params: any, cwd: string): string | undefined {
  if (!params || typeof params !== 'object') return undefined;
  const path = params.AbsolutePath ?? params.TargetFile ?? params.FilePath ?? params.Path ?? params.DirectoryPath;
  if (typeof path === 'string') return shortPath(path, cwd);
  const cmd = params.CommandLine ?? params.Command ?? params.Query ?? params.Url ?? params.Pattern;
  if (typeof cmd === 'string') return truncate(cmd, 140);
  return truncate(JSON.stringify(params), 140);
}

function fitPrompt(prompt: string): string {
  if (Buffer.byteLength(prompt) <= MAX_PROMPT_BYTES) return prompt;
  // Keep the end: the actual task is last, older chat context comes first.
  let tail = prompt.slice(-Math.floor(MAX_PROMPT_BYTES / 3));
  while (Buffer.byteLength(tail) > MAX_PROMPT_BYTES - 200) tail = tail.slice(1000);
  return `…[начало контекста обрезано]\n${tail}`;
}
