// A minimal Telegram Bot API client over fetch (Node 18+). Long polling, so no public URL is needed.

export interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
}

export interface TgChat {
  id: number;
  type: string;
}

export interface TgMessage {
  message_id: number;
  /** Unix seconds. */
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  reply_to_message?: TgMessage;
}

export interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export type Keyboard = InlineButton[][];

export class TelegramError extends Error {
  constructor(
    readonly method: string,
    readonly code: number,
    readonly description: string,
    /** Seconds to wait on 429. */
    readonly retryAfter?: number,
  ) {
    super(`Telegram ${method}: ${code} ${description}`);
  }
}

/** Long-poll wait, seconds: the request stays open this long when nothing happens. */
export const POLL_TIMEOUT = 50;

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly base = 'https://api.telegram.org',
  ) {}

  async call<T>(method: string, params: object = {}, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.base.replace(/\/+$/, '')}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
    const body: any = await res.json().catch(() => ({ ok: false, description: res.statusText }));
    if (!body.ok) throw new TelegramError(method, body.error_code ?? res.status, body.description ?? 'error', body.parameters?.retry_after);
    return body.result as T;
  }

  getMe(): Promise<TgUser> {
    return this.call('getMe');
  }

  getUpdates(offset: number, signal: AbortSignal): Promise<TgUpdate[]> {
    // The request outlives the long-poll wait a little; the caller's signal ends it on shutdown.
    const timeout = AbortSignal.timeout((POLL_TIMEOUT + 15) * 1000);
    return this.call('getUpdates', { offset, timeout: POLL_TIMEOUT, allowed_updates: ['message', 'callback_query'] }, AbortSignal.any([signal, timeout]));
  }

  send(chatId: number, html: string, opts: { keyboard?: Keyboard; silent?: boolean; replyTo?: number } = {}): Promise<TgMessage> {
    return this.call('sendMessage', {
      chat_id: chatId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      disable_notification: opts.silent,
      reply_markup: opts.keyboard?.length ? { inline_keyboard: opts.keyboard } : undefined,
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
    });
  }

  edit(chatId: number, messageId: number, html: string, keyboard?: Keyboard): Promise<unknown> {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text: html,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard ?? [] },
    });
  }

  delete(chatId: number, messageId: number): Promise<unknown> {
    return this.call('deleteMessage', { chat_id: chatId, message_id: messageId });
  }

  answer(callbackId: string, text?: string): Promise<unknown> {
    return this.call('answerCallbackQuery', { callback_query_id: callbackId, text });
  }

  setCommands(commands: { command: string; description: string }[], languageCode?: string): Promise<unknown> {
    return this.call('setMyCommands', { commands, language_code: languageCode });
  }

  deleteWebhook(): Promise<unknown> {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }
}
