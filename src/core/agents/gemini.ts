import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { t } from '../../i18n';
import { prompts } from '../prompts';
import type { AgentAdapter, AgentEvent, AgentLimits, AgentStatus, LimitWindow, RunOutcome, RunRequest, Usage } from '../types';
import { type JsonlRun, type Logger, nullLogger, resolveBinary, runJsonl, runText, truncate, tryParseJson } from '../proc';
import { shortPath } from './claude';

/** Linux caps a single argv string at 128 KiB, and `agy -p` only takes the prompt as an argument. */
const MAX_PROMPT_BYTES = 120_000;
const EFFORT_IN_SLUG = /-(low|medium|high)$/;
/**
 * Broken model output (an empty function call, an empty reply). agy's agent loop answers it with
 * "please retry", but print mode ends the run on that step (agy 1.4.10), so we resume the conversation ourselves.
 */
const MODEL_GLITCH = /improperly formatted function call|malformed function call|model output must contain either output text or tool calls/i;
const GLITCH_RETRIES = 2;
const MAX_EXTRA_DIRS = 16;

/**
 * Drives the official Antigravity CLI: `agy -p <prompt> --output-format stream-json`.
 * Events look like {"event":"init"|"step_update"|"result", <event>: {...}}.
 */
export class GeminiAdapter implements AgentAdapter {
  readonly id = 'gemini' as const;
  /** Folders outside the workspace that a conversation's prompts named: later turns may go back to them. */
  private readonly extraDirs = new Map<string, string[]>();

  constructor(
    private readonly binary: () => string,
    private readonly log: Logger = nullLogger,
  ) {}

  async detect(): Promise<AgentStatus> {
    const path = await resolveBinary(this.binary());
    if (!path) return { id: this.id, installed: false, error: t().cli.agyNotInstalled };
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
    // Read-only = plan mode without auto-approval: shell commands are denied (--sandbox does not stop
    // `echo > file` in the workspace). Plan mode also nudges the agent towards plan artifacts, hence the hint.
    const hint = autonomy === 'readonly' ? prompts().readonlyGemini : '';
    const flags = ['--output-format', 'stream-json'];
    if (req.model) flags.push('--model', req.model);
    // Antigravity model slugs carry the effort ("gemini-4-argon-high"); only pass --effort for bare slugs.
    if (req.effort && !(req.model && EFFORT_IN_SLUG.test(req.model))) flags.push('--effort', req.effort);
    if (req.jsonSchema) flags.push('--json-schema', JSON.stringify(req.jsonSchema));

    // Print mode can't ask for permission: anything that would prompt is denied.
    // `--mode plan` is silently ignored together with --disable-slash-commands, so that flag is
    // only used when plan mode isn't needed (our prompts never start with "/" anyway).
    if (autonomy === 'readonly') flags.push('--mode', 'plan');
    else if (autonomy === 'auto') flags.push('--dangerously-skip-permissions', '--sandbox', '--disable-slash-commands');
    else flags.push('--dangerously-skip-permissions', '--disable-slash-commands');
    // Plan mode denies reading files outside the workspace ("~/Downloads/prototype.html" from the CEO).
    // The other modes approve everything anyway, and there --add-dir would widen the sandbox for writes.
    const dirs = outermost([...((req.sessionId && this.extraDirs.get(req.sessionId)) || []), ...outsideDirs(req.prompt, req.cwd)]);
    if (autonomy === 'readonly') for (const d of dirs) flags.push('--add-dir', d);

    const s = new GeminiStream(req.cwd, onEvent, !!req.sessionId);
    const once = (prompt: string, conversation?: string) => {
      s.result = undefined;
      const args = ['-p', fitPrompt(prompt), ...flags, ...(conversation ? ['--conversation', conversation] : [])];
      return runJsonl(path, args, { cwd: req.cwd, signal, log: this.log }, (line) => s.handle(tryParseJson(line)));
    };
    let res = await once(brief + req.prompt + hint, req.sessionId);
    // Text, tools and tokens of every attempt add up to one reply.
    for (let retry = 1; retry <= GLITCH_RETRIES && !res.aborted && s.conversationId && !succeeded(s) && MODEL_GLITCH.test(failure(s, res)); retry++) {
      this.log.info(`agy: broken model output, resuming ${s.conversationId} (${retry}/${GLITCH_RETRIES})`);
      res = await once(prompts().glitchGemini + hint, s.conversationId);
    }
    const sessionId = s.conversationId ?? req.sessionId;
    if (sessionId && dirs.length) this.extraDirs.set(sessionId, dirs);
    if (res.aborted) return { ok: false, text: s.text, sessionId, error: t().cli.stopped };

    const r = s.result;
    const response = typeof r?.response === 'string' ? r.response.trim() : '';
    const text = s.text.trim() || response;
    if (succeeded(s)) {
      return { ok: true, text, sessionId, structured: r.structured_output ?? (req.jsonSchema ? tryParseJson(response) : undefined), usage: s.usage };
    }
    return { ok: false, text, sessionId, usage: s.usage, error: failure(s, res) };
  }

  /** `/usage` is answered locally in print mode, without a model call. */
  async readLimits(): Promise<AgentLimits | undefined> {
    const path = await resolveBinary(this.binary());
    if (!path) return undefined;
    return parseAgyUsage(tryParseJson(await runText(path, ['-p', '/usage', '--output-format', 'json'], 30_000)));
  }

  /** `agy models`: "slug<TAB>Display name" per line. The Claude/GPT models there draw on another quota group. */
  async listModels(): Promise<string[]> {
    const path = await resolveBinary(this.binary());
    if (!path) return [];
    return parseAgyModels(await runText(path, ['models'], 30_000));
  }
}

/**
 * Folders of the existing files and folders outside the workspace that a prompt names by absolute path,
 * "~/…" or a file:/// link. Prompts carry colleagues' messages too, with `ls /` output and the like.
 */
export function outsideDirs(text: string, cwd: string): string[] {
  const dirs: string[] = [];
  for (const m of text.matchAll(/(?<![\w.:/~-])(?:file:\/\/)?(~?\/[^\s"'`<>()[\]{}|*]+)/g)) {
    const raw = m[1].replace(/[.,;:!?]+$/, '');
    const path = resolve(raw.startsWith('~') ? join(homedir(), raw.slice(1)) : raw);
    if (isInside(path, cwd)) continue;
    try {
      const dir = statSync(path).isDirectory() ? path : dirname(path);
      if (!tooBroad(dir)) dirs.push(dir);
    } catch {
      /* not a path, or gone */
    }
  }
  return outermost(dirs);
}

/** "/etc", the home folder and its parents, dot-folders in it (~/.ssh, ~/.config), system trees. */
function tooBroad(dir: string): boolean {
  const home = homedir();
  if (dir.split('/').filter(Boolean).length < 2 || isInside(home, dir)) return true;
  if (isInside(dir, home) && relative(home, dir).startsWith('.')) return true;
  return ['/dev', '/proc', '/sys', '/run'].some((d) => isInside(dir, d));
}

/** Each folder once, without those inside another listed one; the latest mentions win the cap. */
function outermost(dirs: string[]): string[] {
  const unique = [...new Set(dirs)];
  return unique.filter((d) => !unique.some((o) => o !== d && isInside(d, o))).slice(-MAX_EXTRA_DIRS);
}

function isInside(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function parseAgyModels(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.split('\t')[0].trim())
    .filter((slug) => /^gemini-[\w.-]+$/.test(slug));
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
  /** This run's model calls. The result's usage covers the whole conversation, earlier runs included. */
  private steps?: Usage;

  constructor(
    private readonly cwd: string,
    private readonly emit: (e: AgentEvent) => void,
    private readonly resumed: boolean,
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
      const usage = this.steps ?? (this.resumed || !body.usage ? undefined : toUsage(body.usage));
      if (usage) {
        this.usage = usage;
        this.emit({ kind: 'usage', usage });
      }
    }
  }

  private step(b: any): void {
    const id = `step-${b.step_index}`;
    if (b.usage && b.state === 'DONE') {
      const u = toUsage(b.usage);
      this.steps = { input: (this.steps?.input ?? 0) + u.input, output: (this.steps?.output ?? 0) + u.output, cached: (this.steps?.cached ?? 0) + (u.cached ?? 0) };
    }
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

function succeeded(s: GeminiStream): boolean {
  const response = typeof s.result?.response === 'string' ? s.result.response.trim() : '';
  return s.result?.status === 'SUCCESS' && !!(s.text.trim() || response);
}

function failure(s: GeminiStream, res: JsonlRun): string {
  const r = s.result;
  const denied: string[] = (r?.denied_actions ?? []).map((d: any) => d.display_name ?? d.action).filter(Boolean);
  const stderr = res.stderr.trim().split('\n').filter((l) => l.trim()).slice(-2).join('\n');
  const reported = typeof r?.error === 'string' ? r.error : r?.error?.message;
  return (
    reported ||
    (denied.length ? t().cli.denied(denied.join(', ')) : '') ||
    stderr ||
    (r ? `agy: ${r.status ?? t().cli.emptyReply}` : t().cli.exited('agy', res.code))
  );
}

function toUsage(u: any): Usage {
  return { input: (u.input_tokens ?? 0) + (u.cache_read_tokens ?? 0), output: (u.output_tokens ?? 0) + (u.thinking_tokens ?? 0), cached: u.cache_read_tokens ?? 0 };
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
  return `${prompts().contextCut}\n${tail}`;
}
