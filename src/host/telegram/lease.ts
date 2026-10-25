import { readFileSync, rmSync, writeFileSync } from 'node:fs';

/** A lease older than this belongs to a window that is gone (it renews every RENEW_MS). */
const STALE_MS = 90_000;
export const RENEW_MS = 30_000;

interface Holder {
  pid: number;
  workspace: string;
  at: number;
}

/**
 * One bot token can be long-polled by one process only (Telegram answers 409 to the second), and every
 * VS Code window runs its own extension host. The window holding this file-based lease serves Telegram;
 * the others check back and take over when it closes.
 */
export class Lease {
  constructor(
    private readonly file: string,
    private readonly workspace: string,
    private readonly pid = process.pid,
  ) {}

  /** Takes the lease if it is free, stale or ours; `force` takes it from another window. */
  acquire(force = false): boolean {
    const h = this.holder();
    if (!force && h && h.pid !== this.pid && Date.now() - h.at < STALE_MS && alive(h.pid)) return false;
    this.write();
    return true;
  }

  /** Renews the lease; false once another window has taken it. */
  renew(): boolean {
    const h = this.holder();
    if (h && h.pid !== this.pid) return false;
    this.write();
    return true;
  }

  release(): void {
    if (this.holder()?.pid === this.pid) rmSync(this.file, { force: true });
  }

  /** The other window serving Telegram, if any. */
  heldBy(): string | undefined {
    const h = this.holder();
    return h && h.pid !== this.pid && Date.now() - h.at < STALE_MS && alive(h.pid) ? h.workspace : undefined;
  }

  private holder(): Holder | undefined {
    try {
      const h = JSON.parse(readFileSync(this.file, 'utf8'));
      return typeof h?.pid === 'number' ? h : undefined;
    } catch {
      return undefined;
    }
  }

  private write(): void {
    writeFileSync(this.file, JSON.stringify({ pid: this.pid, workspace: this.workspace, at: Date.now() } satisfies Holder));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it exists but belongs to someone else.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
