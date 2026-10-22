import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

export const nullLogger: Logger = { info: () => {}, error: () => {} };

export interface JsonlRun {
  code: number | null;
  stderr: string;
  aborted: boolean;
}

/**
 * Spawns a CLI, feeds `stdin`, and calls `onLine` for every stdout line.
 * Aborting kills the whole process group so tool subprocesses die too.
 */
export function runJsonl(
  cmd: string,
  args: string[],
  /** `holdStdin`: write stdin but keep it open (servers that quit on EOF); end the run via `signal`. */
  opts: { cwd: string; stdin?: string; holdStdin?: boolean; signal: AbortSignal; env?: NodeJS.ProcessEnv; log?: Logger },
  onLine: (line: string) => void,
): Promise<JsonlRun> {
  const log = opts.log ?? nullLogger;
  log.info(`$ ${cmd} ${args.map(quoteForLog).join(' ')}  (cwd: ${opts.cwd})`);

  return new Promise((resolve) => {
    if (opts.signal.aborted) return resolve({ code: null, stderr: '', aborted: true });

    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });

    let stderr = '';
    let aborted = false;
    let settled = false;

    const kill = (sig: NodeJS.Signals) => {
      if (child.exitCode !== null || child.pid === undefined) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const onAbort = () => {
      aborted = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 3000).unref();
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const rl = createInterface({ input: child.stdout });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      try {
        onLine(line);
      } catch (e) {
        log.error(`line handler failed: ${String(e)}`);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
    });

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener('abort', onAbort);
      rl.close();
      if (stderr.trim()) log.info(`[stderr] ${stderr.trim().slice(-2000)}`);
      resolve({ code, stderr, aborted });
    };
    child.on('error', (err: NodeJS.ErrnoException) => {
      // spawn reports a missing cwd as ENOENT of the binary, which sends people hunting the wrong problem.
      const missingCwd = err.code === 'ENOENT' && !existsSync(opts.cwd);
      stderr += `\n${missingCwd ? `рабочая папка не найдена: ${opts.cwd}` : err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));

    child.stdin.on('error', () => {});
    if (opts.holdStdin) child.stdin.write(opts.stdin ?? '');
    else child.stdin.end(opts.stdin ?? '');
  });
}

/** Runs a command and returns trimmed stdout (`--version` checks, quota queries). */
export async function runText(cmd: string, args: string[], timeoutMs = 10_000): Promise<string> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let out = '';
  try {
    const res = await runJsonl(cmd, args, { cwd: homedir(), signal: ac.signal }, (l) => (out += l + '\n'));
    if (res.code !== 0) throw new Error(res.stderr.trim() || `exit code ${res.code}`);
    return out.trim();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves a binary name to an absolute path. Editors launched from the desktop
 * often miss shell PATH entries like ~/.local/bin, so common dirs are checked too.
 */
export async function resolveBinary(nameOrPath: string): Promise<string | undefined> {
  if (isAbsolute(nameOrPath)) return (await isExecutable(nameOrPath)) ? nameOrPath : undefined;
  const home = homedir();
  const dirs = [
    ...(process.env.PATH ?? '').split(delimiter),
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.bun', 'bin'),
    join(home, '.cargo', 'bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/usr/bin',
  ];
  const nvmBin = process.env.NVM_BIN;
  if (nvmBin) dirs.push(nvmBin);
  for (const dir of dirs) {
    if (!dir) continue;
    const candidate = join(dir, nameOrPath);
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function quoteForLog(a: string): string {
  const short = a.length > 160 ? `${a.slice(0, 160)}…(${a.length} chars)` : a;
  return /[\s"'$`\\]/.test(short) ? JSON.stringify(short) : short;
}

export function tryParseJson(line: string): any {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

export function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
