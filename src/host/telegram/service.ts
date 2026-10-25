import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../../core/proc';
import type { TelegramView } from '../../core/types';
import { t } from '../../i18n';
import { TelegramApi } from './api';
import { type BridgeHost, TelegramBridge } from './bridge';
import { Lease, RENEW_MS } from './lease';

const TOKEN_KEY = 'harness.telegram.token';
const CHAT_KEY = 'harness.telegram.chat';
const BOT_KEY = 'harness.telegram.bot';

/**
 * The VS Code side of the Telegram bot: the token in the secret storage, the linked chat, the
 * connect/disconnect commands, and which window serves the bot (see Lease).
 */
export class TelegramService implements vscode.Disposable {
  private bridge?: TelegramBridge;
  private readonly lease: Lease;
  private readonly timer: NodeJS.Timeout;
  private starting?: Promise<void>;
  /** The other window serving the bot, as of the last lease check (the view asks on every state change). */
  private elsewhere?: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
    private readonly host: BridgeHost,
    /** The view state changed (connected, linked…). */
    private readonly changed: () => void,
  ) {
    const dir = context.globalStorageUri.fsPath;
    mkdirSync(dir, { recursive: true });
    this.lease = new Lease(join(dir, 'telegram.lock'), vscode.workspace.workspaceFolders?.[0]?.name ?? '—');
    this.timer = setInterval(() => this.tick(), RENEW_MS);
    this.timer.unref?.();
  }

  /** Serves the bot from this window if one is connected and no other window serves it. */
  start(): Promise<void> {
    this.starting ??= this.doStart()
      .catch((e) => this.log.error(`telegram: couldn't start: ${e instanceof Error ? e.message : String(e)}`))
      .finally(() => (this.starting = undefined));
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (!token || !this.enabled()) return this.stopBridge(true);
    if (this.bridge) return;
    if (!this.lease.acquire()) {
      const elsewhere = this.lease.heldBy();
      if (elsewhere !== this.elsewhere) {
        this.elsewhere = elsewhere;
        this.changed();
      }
      return;
    }
    this.elsewhere = undefined;
    this.bridge = new TelegramBridge({
      bot: new TelegramApi(token, this.apiUrl()),
      host: this.host,
      log: this.log,
      chatId: this.context.globalState.get<number>(CHAT_KEY),
      onPaired: (chatId) => {
        void this.context.globalState.update(CHAT_KEY, chatId);
        void vscode.window.showInformationMessage(t().telegram.pairedInfo(this.botName()));
        this.changed();
      },
      onUnauthorized: () => {
        this.stopBridge(true);
        void vscode.window.showWarningMessage(t().telegram.unauthorized);
      },
    });
    this.bridge.start();
    this.log.info(`telegram: serving @${this.botName()} from this window`);
    this.changed();
  }

  /** Settings changed: apply them. */
  restart(): void {
    this.stopBridge(false);
    void this.start();
  }

  /** The chat changed: mirror it. */
  notify(): void {
    this.bridge?.schedule();
  }

  view(): TelegramView {
    const bot = this.context.globalState.get<string>(BOT_KEY);
    if (!bot) return { state: 'off' };
    if (this.bridge) return { state: this.bridge.paired ? 'on' : 'pairing', bot };
    return this.elsewhere ? { state: 'elsewhere', bot, window: this.elsewhere } : { state: 'off', bot };
  }

  /** The "Connect Telegram" command: a token, then a one-time link that ties the CEO's chat to the bot. */
  async connect(): Promise<void> {
    const s = t().telegram;
    const token = await this.context.secrets.get(TOKEN_KEY);
    if (token && this.botName()) {
      const items = [
        ...(this.bridge ? [] : [{ label: s.useHere, id: 'here' }]),
        { label: s.repair, id: 'pair' },
        { label: s.otherBot, id: 'token' },
        { label: s.disconnect, id: 'off' },
      ];
      const pick = await vscode.window.showQuickPick(items, { title: s.menuTitle(this.botName()) });
      if (!pick) return;
      if (pick.id === 'off') return this.disconnect();
      if (pick.id === 'here' || pick.id === 'pair') {
        await this.takeOver();
        if (pick.id === 'pair' || !this.bridge?.paired) await this.pair();
        return;
      }
    }

    const input = await vscode.window.showInputBox({
      title: s.tokenTitle,
      prompt: s.tokenPrompt,
      password: true,
      ignoreFocusOut: true,
      validateInput: (v) => (/^\d+:[\w-]{20,}$/.test(v.trim()) ? undefined : s.tokenFormat),
    });
    if (!input) return;
    const fresh = input.trim();
    let username: string | undefined;
    try {
      username = (await new TelegramApi(fresh, this.apiUrl()).getMe()).username;
    } catch (e) {
      void vscode.window.showErrorMessage(s.tokenInvalid(e instanceof Error ? e.message : String(e)));
      return;
    }
    this.stopBridge(true);
    await this.context.secrets.store(TOKEN_KEY, fresh);
    await this.context.globalState.update(BOT_KEY, username);
    await this.context.globalState.update(CHAT_KEY, undefined);
    await this.takeOver();
    await this.pair();
  }

  async disconnect(): Promise<void> {
    this.stopBridge(true);
    await this.context.secrets.delete(TOKEN_KEY);
    await this.context.globalState.update(CHAT_KEY, undefined);
    await this.context.globalState.update(BOT_KEY, undefined);
    this.changed();
    void vscode.window.showInformationMessage(t().telegram.disconnected);
  }

  /** This window serves the bot from now on; the other one notices at its next lease renewal. */
  private async takeOver(): Promise<void> {
    if (this.bridge) return;
    this.lease.acquire(true);
    await this.start();
  }

  private async pair(): Promise<void> {
    if (!this.bridge) return;
    const s = t().telegram;
    // 72 random bits: the code is all that stands between a stranger who finds the bot and the team.
    const code = randomBytes(9).toString('base64url');
    this.bridge.expectPairing(code);
    this.changed();
    const bot = this.botName();
    const pick = await vscode.window.showInformationMessage(s.pairPrompt(bot), s.openTelegram, s.copyCommand);
    if (pick === s.openTelegram) await vscode.env.openExternal(vscode.Uri.parse(`https://t.me/${bot}?start=${code}`));
    if (pick === s.copyCommand) await vscode.env.clipboard.writeText(`/start ${code}`);
  }

  private tick(): void {
    if (!this.bridge) return void this.start();
    if (!this.lease.renew()) {
      this.log.info('telegram: another window took the bot over');
      this.stopBridge(false);
    }
  }

  private stopBridge(release: boolean): void {
    if (this.bridge) {
      this.bridge.stop();
      this.bridge = undefined;
      this.changed();
    }
    if (release) this.lease.release();
  }

  private botName(): string {
    return this.context.globalState.get<string>(BOT_KEY) ?? 'bot';
  }

  private enabled(): boolean {
    return vscode.workspace.getConfiguration('harness').get<boolean>('telegram.enabled', true);
  }

  private apiUrl(): string {
    return vscode.workspace.getConfiguration('harness').get<string>('telegram.apiUrl') || 'https://api.telegram.org';
  }

  dispose(): void {
    clearInterval(this.timer);
    this.stopBridge(true);
  }
}
