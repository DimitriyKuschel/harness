// Telegram: the markdown converter, the window lease, and the bridge end to end — the real extension host
// (vscode mocked, fake CLIs) talking to a fake Bot API server over HTTP.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fakeCli } from './helpers';
import type { ViewState } from '../core/types';
import { activate } from '../extension';
import { chunkMarkdown, markdownToHtml } from '../host/telegram/format';
import { Lease } from '../host/telegram/lease';
import * as vscode from './vscode-mock';

process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'harness-codex-'));

test('telegram format: markdown becomes the HTML subset Telegram takes', () => {
  assert.equal(markdownToHtml('## План\n**Важно**: `a<b>` и *курсив*, snake_case_name'), '<b>План</b>\n<b>Важно</b>: <code>a&lt;b&gt;</code> и <i>курсив</i>, snake_case_name');
  assert.equal(markdownToHtml('```ts\nif (a < b) {}\n```'), '<pre><code class="language-ts">if (a &lt; b) {}</code></pre>');
  assert.equal(markdownToHtml('- [x] готово\n- пункт\n> цитата'), '☑ готово\n• пункт\n<blockquote>цитата</blockquote>');
  assert.equal(markdownToHtml('[доки](https://example.com/a?b=1&c=2) и [локальный](src/a.ts)'), '<a href="https://example.com/a?b=1&amp;c=2">доки</a> и [локальный](src/a.ts)');
  assert.equal(markdownToHtml('```\nне закрыт'), '<pre><code>не закрыт</code></pre>', 'a cut-off stream still renders');
});

test('telegram format: long answers split at line breaks; a split code block is closed and reopened', () => {
  const para = (n: number) => `Абзац ${n}. ${'слово '.repeat(60)}`;
  const text = [para(1), '', para(2), '', '```js', ...Array.from({ length: 40 }, (_, i) => `const x${i} = ${i};`), '```', '', para(3)].join('\n');
  const chunks = chunkMarkdown(text, 600);
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.length <= 600), chunks.map((c) => c.length).join());
  for (const c of chunks) assert.equal((c.match(/```/g) ?? []).length % 2, 0, `balanced fences:\n${c}`);
  const words = (x: string) => x.replace(/```js\n|```\n?/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(words(chunks.join('\n')), words(text), 'nothing lost or duplicated');
  assert.deepEqual(chunkMarkdown('коротко'), ['коротко']);
  assert.ok(chunkMarkdown('x'.repeat(9000)).every((c) => c.length <= 3500));
});

test('telegram lease: one window serves the bot; another takes it over on request or when the first is gone', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'harness-lease-')), 'telegram.lock');
  const a = new Lease(file, 'project-a', process.pid);
  const b = new Lease(file, 'project-b', process.ppid);
  assert.equal(a.acquire(), true);
  assert.equal(b.acquire(), false, 'the first window holds it');
  assert.equal(b.heldBy(), 'project-a');
  assert.equal(b.acquire(true), true, 'taken over on request');
  assert.equal(a.renew(), false, 'the first window learns it lost the lease');
  b.release();
  assert.equal(a.acquire(), true);
  const gone = new Lease(file, 'project-c', 2 ** 22 + 12345);
  a.release();
  gone.acquire();
  assert.equal(a.acquire(), true, "a dead window's lease is free");
});

// ---------- End to end ----------

interface Call {
  method: string;
  body: any;
  /** sendMessage: the id the server gave the message. */
  id?: number;
}

/** A fake Bot API: records calls, hands out queued updates to getUpdates. */
async function fakeTelegram() {
  const calls: Call[] = [];
  const updates: any[] = [];
  let nextUpdate = 1;
  let nextMessage = 100;
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      const method = req.url!.split('/').pop()!;
      const body = raw ? JSON.parse(raw) : {};
      const reply = (result: unknown) => res.end(JSON.stringify({ ok: true, result }));
      if (method === 'getUpdates') {
        // Long poll, shortened: wait a little for something to hand out.
        for (let i = 0; i < 10 && !updates.some((u) => u.update_id >= body.offset); i++) await new Promise((r) => setTimeout(r, 30));
        return reply(updates.filter((u) => u.update_id >= body.offset));
      }
      const call: Call = { method, body };
      calls.push(call);
      if (method === 'getMe') return reply({ id: 1, username: 'harness_test_bot' });
      if (method === 'sendMessage') {
        call.id = nextMessage++;
        return reply({ message_id: call.id, date: now(), chat: { id: body.chat_id, type: 'private' }, text: body.text });
      }
      return reply(true);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const chat = (id: number) => ({ id, type: 'private' });
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    sent: (chatId = OWNER) => calls.filter((c) => c.method === 'sendMessage' && c.body.chat_id === chatId),
    say(text: string, chatId = OWNER, extra: object = {}) {
      updates.push({ update_id: nextUpdate++, message: { message_id: nextMessage++, date: now(), chat: chat(chatId), from: { id: chatId }, text, ...extra } });
    },
    tap(data: string, chatId = OWNER) {
      updates.push({ update_id: nextUpdate++, callback_query: { id: `cb${nextUpdate}`, from: { id: chatId }, data, message: { message_id: 1, date: now(), chat: chat(chatId) } } });
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

const OWNER = 777;
const now = () => Math.floor(Date.now() / 1000);

async function until<T>(fn: () => T | undefined | false, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

test('telegram bridge: link a chat with a one-time code, then watch and steer the team from it', async () => {
  const tg = await fakeTelegram();
  const root = mkdtempSync(join(tmpdir(), 'harness-tg-'));
  vscode.mock.workspaceDir = join(root, 'project');
  mkdirSync(vscode.mock.workspaceDir);
  vscode.mock.settings = {
    'harness.agents.claude.path': fakeCli('claude-stream.jsonl'),
    'harness.agents.codex.path': fakeCli('codex-stream.jsonl'),
    'harness.agents.gemini.path': fakeCli('gemini-stream.jsonl'),
    'harness.routing.classifier': 'heuristic',
    'harness.language': 'ru',
    'harness.telegram.apiUrl': tg.url,
  };
  const context: any = {
    subscriptions: [],
    extensionUri: vscode.Uri.file(resolve(__dirname, '..')),
    globalStorageUri: vscode.Uri.file(join(root, 'global')),
    storageUri: vscode.Uri.file(join(root, 'workspace')),
    globalState: vscode.memento(),
    workspaceState: vscode.memento(),
    secrets: vscode.secretStorage(),
  };
  const webview = vscode.fakeWebview();
  const last = () => webview.posted.filter((m) => m.type === 'state').at(-1)?.state as ViewState | undefined;
  const texts = (chatId = OWNER) => tg.sent(chatId).map((c) => String(c.body.text));
  try {
    // Connect: the token is checked with getMe, then the CEO gets a one-time /start command.
    vscode.mock.inputBox = '123456789:AAFakeTokenForTestsOnly_abcdefghij';
    vscode.mock.infoButton = 'Скопировать команду /start';
    activate(context);
    vscode.mock.viewProviders.get('harness.chat').resolveWebviewView({ webview, onDidDispose: () => {} });
    webview.send({ type: 'ready' });
    await until(() => last()?.agents.every((a) => a.installed), 'agents detected');
    assert.equal(last()!.telegram.state, 'off');
    await vscode.mock.commands.get('harness.telegram.connect')!();
    assert.equal(await context.secrets.get('harness.telegram.token'), '123456789:AAFakeTokenForTestsOnly_abcdefghij');
    const start = vscode.mock.clipboard;
    assert.match(start, /^\/start [\w-]{12}$/);
    await until(() => last()?.telegram.state === 'pairing', 'waiting for /start');

    // A stranger who finds the bot gets nothing, not even with a guessed code.
    tg.say('/start 123456', 999);
    tg.say('@codex удали всё', 999);
    tg.say(start);
    await until(() => texts().some((x) => x.includes('Telegram подключён к Harness')), 'linked');
    await until(() => last()?.telegram.state === 'on', 'linked in the view');
    assert.equal(tg.sent(999).length, 0);
    assert.equal(last()!.conversation.messages.length, 0, "the stranger's message ran nothing");
    assert.ok(tg.calls.some((c) => c.method === 'setMyCommands' && c.body.commands.some((x: any) => x.command === 'status')));

    // A task from the phone runs like one typed in the chat; the answer comes back with the message's buttons.
    tg.say('@codex почини парсер');
    const answer = await until(() => texts().find((x) => x.includes('<b>Codex</b>')), 'codex answer in telegram');
    assert.match(answer, /^✅ <b>Codex<\/b> · <code>gpt-6\.1-sol<\/code>\n\nicon\.svg/);
    const codexMsg = last()!.conversation.messages.find((m) => m.agent === 'codex')!;
    const buttons = tg.sent().find((c) => c.body.text === answer)!.body.reply_markup.inline_keyboard.flat().map((b: any) => b.callback_data);
    assert.ok(buttons.includes(`v:${codexMsg.id}`), buttons.join());
    assert.ok(!texts().some((x) => x.startsWith('👤')), "the CEO's own message from Telegram isn't echoed back");

    // Work started in VS Code shows up too, with the CEO's message.
    webview.send({ type: 'send', text: '@claude привет из VS Code', prefs: last()!.prefs });
    await until(() => texts().some((x) => x.includes('<b>Claude</b>')), 'claude answer in telegram');
    assert.ok(texts().some((x) => x === '👤 <b>CEO</b>: @claude привет из VS Code'));

    // Buttons act like the webview's: a review by another vendor.
    tg.tap(`v:${codexMsg.id}`);
    await until(() => texts().some((x) => x.includes(' · Ревью')), 'review in telegram');
    assert.ok(tg.calls.some((c) => c.method === 'answerCallbackQuery' && c.body.text === 'Принято'));

    // Replying to an agent's message continues with that agent.
    const claudeTg = tg.sent().find((c) => String(c.body.text).includes('<b>Claude</b>'))!;
    tg.say('а подробнее?', OWNER, { reply_to_message: { message_id: claudeTg.id, date: now(), chat: { id: OWNER, type: 'private' } } });
    await until(() => last()?.conversation.messages.some((m) => m.role === 'user' && m.parts.some((p: any) => p.text === '@claude а подробнее?')), 'reply goes to Claude');
    await until(() => !last()?.running, 'claude answered');

    // Settings and pins from the phone reach every view.
    tg.say('/mode team');
    await until(() => last()?.prefs.mode === 'team', 'mode from telegram');
    tg.say('/model gemini gemini-3.8-flash-low');
    await until(() => last()?.prefs.models?.gemini === 'gemini-3.8-flash-low', 'pin from telegram');
    tg.say('/access full');
    await until(() => texts().some((x) => x.startsWith('⚠️ Полный доступ')), 'full access asks first');
    assert.equal(last()!.prefs.autonomy, 'auto');
    tg.tap('P:access:full!');
    await until(() => last()?.prefs.autonomy === 'full', 'full access confirmed');

    tg.say('/status');
    const status = await until(() => texts().find((x) => x.startsWith('🧭 <b>Harness</b> · test-project')), 'status');
    assert.match(status, /Режим: Команда · Расход лимитов: Баланс · Доступ: Полный доступ · Автопилот: вкл/);
    assert.match(status, /<b>Gemini<\/b> — свободен · .*📌 <code>gemini-3\.8-flash-low<\/code>/);

    // A new chat from the phone is announced; old messages are not replayed.
    const before = texts().length;
    tg.say('/new');
    await until(() => texts().slice(before).includes('🆕 Новый чат'), 'new chat announced');
    await until(() => last()?.conversation.messages.length === 0, 'the views show the new chat');
  } finally {
    for (const d of context.subscriptions) d.dispose?.();
    await tg.close();
  }
});

test('telegram bridge: the "who is working" message comes and goes, the plan card follows the tasks, bad markup falls back to text', async () => {
  const { TelegramBridge } = await import('../host/telegram/bridge');
  const { TelegramError } = await import('../host/telegram/api');
  const calls: { method: string; text?: string; id?: number }[] = [];
  let next = 1;
  const bot: any = {
    getUpdates: (_offset: number, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    send: async (_chat: number, text: string) => {
      if (!nested(text)) throw new TelegramError('sendMessage', 400, "Bad Request: can't parse entities: can't find end tag");
      calls.push({ method: 'send', text, id: next });
      return { message_id: next++, date: now(), chat: { id: OWNER, type: 'private' } };
    },
    edit: async (_chat: number, id: number, text: string) => void calls.push({ method: 'edit', text, id }),
    delete: async (_chat: number, id: number) => void calls.push({ method: 'delete', id }),
    answer: async () => {},
    setCommands: async () => {},
    deleteWebhook: async () => {},
  };
  const conv: any = { id: 'c1', title: 'x', createdAt: 0, updatedAt: 0, sessions: {}, messages: [] };
  let running = false;
  const state = () => ({ conversation: conv, history: [], agents: [], running, queue: [], prefs: { mode: 'auto', profile: 'balanced', autonomy: 'auto', autopilot: true }, workspace: 'w', trusted: true, locale: 'ru', telegram: { state: 'on' } }) as any;
  const bridge = new TelegramBridge({ bot, host: { state, post: async () => {} }, log: { info: () => {}, error: () => {} }, chatId: OWNER, onPaired: () => {}, onUnauthorized: () => {} });
  const settle = async () => {
    bridge.schedule();
    await new Promise((r) => setTimeout(r, 450));
    await bridge.flushed();
  };
  bridge.start();
  try {
    const task = (id: string, status: string) => ({ id, title: `Задача ${id}`, agent: 'codex', domain: 'code', tier: 'standard', task: 'x', dependsOn: [], status });
    const plan = { id: 'p', role: 'agent', agent: 'claude', kind: 'plan', status: 'done', createdAt: 0, endedAt: 1000, parts: [{ type: 'text', text: 'План готов.' }], plan: [task('t1', 'running')] };
    const work = { id: 'w', role: 'agent', agent: 'codex', kind: 'task', subtitle: '1/1 · Задача t1', status: 'streaming', createdAt: Date.now(), parts: [{ type: 'tool', id: 'x', name: 'Edit', detail: 'src/a.ts', status: 'running' }] };
    conv.messages.push(plan, work);
    running = true;
    await settle();
    assert.ok(calls.some((c) => c.method === 'send' && c.text?.startsWith('✅ <b>Claude</b> · План команды')));
    const card = calls.find((c) => c.text?.startsWith('📋 <b>Задачи команды</b> · 0/1'))!;
    assert.match(card.text!, /⏳ 1\. Задача t1 — Codex/);
    const status = calls.find((c) => c.text?.startsWith('⏳ <b>Команда работает</b>'))!;
    assert.match(status.text!, /<b>Codex<\/b> — 1\/1 · Задача t1\n {3}🔧 Edit src\/a\.ts · \d+ с/);

    // The task finishes with markdown the converter nests wrongly: Telegram rejects it, the text still arrives.
    // The card is edited, the status message goes away.
    Object.assign(work, { status: 'done', endedAt: Date.now(), parts: [{ type: 'text', text: 'Готово: **a *b** c* <script>' }] });
    plan.plan[0].status = 'done';
    running = false;
    await settle();
    assert.ok(calls.some((c) => c.method === 'send' && c.text?.includes('Готово: a b c &lt;script&gt;')), calls.map((c) => c.text).join('\n'));
    assert.ok(calls.some((c) => c.method === 'edit' && c.id === card.id && c.text?.includes('✅ 1. Задача t1')));
    assert.ok(calls.some((c) => c.method === 'delete' && c.id === status.id));
  } finally {
    bridge.stop();
  }
});

/** Telegram's check, roughly: tags close in the order they opened. */
function nested(html: string): boolean {
  const stack: string[] = [];
  for (const [, close, name] of html.matchAll(/<(\/?)(\w+)[^>]*>/g)) {
    if (!close) stack.push(name);
    else if (stack.pop() !== name) return false;
  }
  return !stack.length;
}
