// Extension host end-to-end: activation → webview → chat flows, with `vscode` mocked and
// fake CLIs replaying recorded streams (no quota spent).
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fakeCli, fakeCliSeq, fakeReplyCli } from './helpers';
import type { ViewState } from '../core/types';
import { activate } from '../extension';
import * as vscode from './vscode-mock';

// Hermetic: no quota from this machine's own Codex sessions.
process.env.CODEX_HOME = mkdtempSync(join(tmpdir(), 'harness-codex-'));

async function until<T>(fn: () => T | undefined, what: string, ms = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > ms) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Activates the extension in a fresh temp workspace with fake CLIs and opens the chat view. */
function startHost(settings: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'harness-host-'));
  vscode.mock.workspaceDir = join(root, 'project');
  mkdirSync(vscode.mock.workspaceDir);
  vscode.mock.settings = {
    'harness.agents.claude.path': fakeCli('claude-stream.jsonl'),
    'harness.agents.codex.path': fakeCli('codex-stream.jsonl'),
    'harness.agents.gemini.path': fakeCli('gemini-stream.jsonl'),
    'harness.routing.classifier': 'heuristic',
    ...settings,
  };
  const context: any = {
    subscriptions: [],
    extensionUri: vscode.Uri.file(resolve(__dirname, '..')),
    globalStorageUri: vscode.Uri.file(join(root, 'global')),
    storageUri: vscode.Uri.file(join(root, 'workspace')),
    globalState: vscode.memento(),
    workspaceState: vscode.memento(),
  };

  activate(context);
  const webview = vscode.fakeWebview();
  vscode.mock.viewProviders.get('harness.chat').resolveWebviewView({ webview, onDidDispose: () => {} });
  const states = () => webview.posted.filter((m) => m.type === 'state').map((m) => m.state as ViewState);
  const last = () => states().at(-1);
  const dispose = () => {
    for (const d of context.subscriptions) d.dispose?.();
  };
  return { root, webview, last, dispose };
}

test('extension host: chat, mentions, brainstorm, review, persistence', async () => {
  const { root, webview, last, dispose } = startHost();
  assert.match(webview.html, /Content-Security-Policy/);

  const idle = (n: number) => () => {
    const s = last();
    return s && !s.running && s.conversation.messages.filter((m) => m.role !== 'system').length >= n ? s : undefined;
  };

  webview.send({ type: 'ready' });
  const ready = await until(() => (last()?.agents.every((a) => a.installed) ? last() : undefined), 'agents detected');
  assert.equal(ready.workspace, 'test-project');
  assert.equal(ready.prefs.mode, 'auto');

  const prefs = { mode: 'auto', profile: 'balanced', autonomy: 'readonly' };

  // Auto-routed (heuristic): a code question goes to Codex.
  webview.send({ type: 'send', text: 'почини баг в функции парсинга', prefs });
  let s = await until(idle(2), 'auto-routed answer');
  let answer = s.conversation.messages[1];
  assert.equal(answer.agent, 'codex');
  assert.equal(answer.status, 'done', answer.error);
  assert.equal(answer.route?.via, 'heuristic');
  assert.equal(answer.route?.model, 'gpt-6.1-sol');
  assert.ok(answer.parts.some((p) => p.type === 'tool'));
  assert.equal(s.conversation.title, 'почини баг в функции парсинга');

  // Explicit mention.
  webview.send({ type: 'send', text: '@gemini посмотри', prefs });
  s = await until(idle(4), 'mention answer');
  answer = s.conversation.messages.filter((m) => m.role !== 'system')[3];
  assert.equal(answer.agent, 'gemini');
  assert.equal(answer.route?.via, 'mention');
  assert.equal(answer.parts.find((p) => p.type === 'text')?.type, 'text');

  // Brainstorm: three answers + a synthesis in one round.
  webview.send({ type: 'send', text: 'что улучшить?', prefs: { ...prefs, mode: 'brainstorm' } });
  s = await until(idle(9), 'brainstorm + synthesis');
  const round = s.conversation.messages.filter((m) => m.kind === 'brainstorm');
  assert.equal(round.length, 3);
  assert.ok(round.every((m) => m.route?.autonomy === 'readonly' && m.round === round[0].round));
  const synthesis = s.conversation.messages.find((m) => m.kind === 'synthesis');
  assert.equal(synthesis?.status, 'done', synthesis?.error);
  assert.equal(synthesis?.round, round[0].round);

  // Cross-review goes to a different vendor.
  const codexAnswer = s.conversation.messages[1];
  webview.send({ type: 'review', id: codexAnswer.id });
  s = await until(idle(10), 'review');
  const review = s.conversation.messages.find((m) => m.kind === 'review');
  assert.ok(review && review.agent !== 'codex' && review.replyTo === codexAnswer.id);

  // Queue while running: the second message only starts after the first is answered.
  webview.send({ type: 'send', text: '@claude один', prefs });
  webview.send({ type: 'send', text: '@claude два', prefs });
  s = await until(idle(14), 'queue drained');
  assert.equal(s.queue.length, 0);
  const tail = s.conversation.messages.filter((m) => m.role !== 'system').slice(-4);
  assert.deepEqual(
    tail.map((m) => (m.role === 'user' ? m.parts.map((p: any) => p.text).join('') : m.agent)),
    ['@claude один', 'claude', '@claude два', 'claude'],
  );

  // Sessions are kept per agent; history is persisted per workspace.
  const conv = s.conversation;
  assert.ok(conv.sessions.claude?.id && conv.sessions.codex?.id && conv.sessions.gemini?.id);
  await until(() => (last()?.history.length === 1 ? last() : undefined), 'saved to history');
  assert.equal(readdirSync(join(root, 'workspace', 'conversations')).length, 1);

  // File references open in the editor.
  webview.send({ type: 'openFile', path: 'package.json:3' });
  await until(() => vscode.mock.opened.length > 0 || vscode.mock.warnings.length > 0, 'openFile handled');

  // New chat, then reopen the saved one.
  webview.send({ type: 'newChat' });
  await until(() => (last()?.conversation.messages.length === 0 ? last() : undefined), 'new chat');
  webview.send({ type: 'openChat', id: conv.id });
  await until(() => (last()?.conversation.id === conv.id ? last() : undefined), 'reopened chat');

  dispose();
});

test('handoff: an agent that @mentions a colleague passes the turn; the relay stops at the limit', async () => {
  const prefs = { mode: 'auto', profile: 'balanced', autonomy: 'readonly' };
  const visible = (s: ViewState) => s.conversation.messages.filter((m) => m.role !== 'system');
  const idle = (n: number) => () => {
    const s = last();
    return s && !s.running && visible(s).length >= n ? s : undefined;
  };
  let { last, webview, dispose } = startHost({ 'harness.agents.codex.path': fakeCli('codex-handoff.jsonl') });
  webview.send({ type: 'ready' });
  await until(() => (last()?.agents.every((a) => a.installed) ? last() : undefined), 'agents detected');

  // Codex asks Claude to check its work; mentions inside code and quotes don't count.
  webview.send({ type: 'send', text: '@codex исправь парсер', prefs });
  let s = await until(idle(3), 'codex → claude');
  let [, codex, claude] = visible(s);
  assert.equal(codex.agent, 'codex');
  assert.equal(claude.agent, 'claude');
  assert.equal(claude.status, 'done', claude.error);
  assert.equal(claude.replyTo, codex.id);
  assert.equal(claude.subtitle, 'по просьбе Codex');
  assert.match(claude.prompt ?? '', /Codex обратился к тебе[\s\S]*@Claude, проверь/);
  assert.equal(claude.route?.tier, codex.route?.tier, 'the handoff keeps the level of the work it continues');
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(visible(last()!).length, 3, 'Claude mentioned nobody: the relay ends; Gemini is not called');
  dispose();

  // Codex and Gemini keep calling each other: the relay stops after maxHandoffs rounds and asks the CEO.
  ({ last, webview, dispose } = startHost({
    'harness.agents.codex.path': fakeCli('codex-ping.jsonl'),
    'harness.agents.gemini.path': fakeCli('gemini-handoff.jsonl'),
    'harness.team.maxHandoffs': 2,
  }));
  webview.send({ type: 'ready' });
  await until(() => (last()?.agents.every((a) => a.installed) ? last() : undefined), 'agents detected');
  webview.send({ type: 'send', text: '@codex начни', prefs });
  s = await until(idle(4), 'ping-pong');
  assert.deepEqual(visible(s).map((m) => m.agent ?? 'CEO'), ['CEO', 'codex', 'gemini', 'codex']);
  const notice = s.conversation.messages.at(-1)!;
  assert.equal(notice.role, 'system');
  assert.match(notice.parts.map((p: any) => p.text).join(''), /2 раз подряд.*Gemini \(зовёт Codex\)/);
  dispose();
});

test('restricted mode: the chat opens but agents do not run until the folder is trusted', async () => {
  vscode.mock.trusted = false;
  const { webview, last, dispose } = startHost();
  try {
    webview.send({ type: 'ready' });
    const s = await until(() => (last()?.agents.every((a) => a.installed) ? last() : undefined), 'agents detected');
    assert.equal(s.trusted, false);
    webview.send({ type: 'send', text: '@claude привет', prefs: { mode: 'auto', profile: 'balanced', autonomy: 'readonly' } });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(last()!.conversation.messages.length, 0);
    assert.equal(last()!.running, false);
  } finally {
    vscode.mock.trusted = true;
    dispose();
  }
});

test('team mode: the lead plans, the team executes in dependency order, the lead reports', async () => {
  const { webview, last, dispose } = startHost({ 'harness.agents.claude.path': fakeCli('claude-plan.jsonl') });
  try {
    webview.send({ type: 'ready' });
    await until(() => (last()?.agents.every((a) => a.installed) ? last() : undefined), 'agents detected');
    webview.send({ type: 'send', text: 'Сделайте клон asana', prefs: { mode: 'team', profile: 'balanced', autonomy: 'auto' } });
    const s = await until(() => {
      const st = last();
      return st && !st.running && st.conversation.messages.some((m) => m.kind === 'report' && m.status !== 'streaming') ? st : undefined;
    }, 'team run finished');

    const msgs = s.conversation.messages;
    const plan = msgs.find((m) => m.kind === 'plan')!;
    assert.equal(plan.agent, 'claude', 'planning affinity picks Claude as the lead');
    assert.ok(!plan.parts.some((p: any) => p.type === 'text' && p.text.includes('```team-plan')), 'plan block is hidden from the chat');
    assert.deepEqual(plan.plan?.map((t) => [t.id, t.agent, t.status]), [['t1', 'codex', 'done'], ['t2', 'gemini', 'done'], ['t3', 'claude', 'done']]);

    const exec = (id: string) => msgs.find((m) => m.id === plan.plan!.find((t) => t.id === id)!.messageId)!;
    for (const id of ['t1', 't2', 't3']) {
      const m = exec(id);
      assert.equal(m.kind, 'task');
      assert.equal(m.taskId, id);
      assert.equal(m.replyTo, plan.id);
      assert.equal(m.status, 'done', m.error);
      assert.ok(m.prompt?.includes(plan.plan!.find((t) => t.id === id)!.task));
    }
    assert.ok(exec('t3').createdAt >= exec('t1').endedAt!, 't3 waits for its dependency');
    assert.equal(exec('t1').route?.model, 'gpt-6.1-sol');

    const report = msgs.find((m) => m.kind === 'report')!;
    assert.equal(report.agent, 'claude');
    assert.equal(report.status, 'done', report.error);
    assert.ok(report.prompt?.includes('t1 · Codex'));
  } finally {
    dispose();
  }
});

const TEAM_PREFS = { mode: 'team', profile: 'balanced', autonomy: 'auto', autopilot: true };
const AUTOPILOT_SEQ = ['claude-autopilot-plan.jsonl', 'claude-autopilot-continue.jsonl', 'claude-autopilot-done.jsonl'];

test('autopilot: the team keeps iterating until the lead says the goal is reached', async () => {
  const { webview, last, dispose } = startHost({ 'harness.agents.claude.path': fakeCliSeq(AUTOPILOT_SEQ) });
  try {
    webview.send({ type: 'ready' });
    await until(() => (last()?.agents.every((a) => a.installed) ? last() : undefined), 'agents detected');
    webview.send({ type: 'send', text: 'Сделайте API и макеты', prefs: TEAM_PREFS });
    const s = await until(() => {
      const st = last();
      return st && !st.running && st.conversation.messages.some((m) => m.teamStatus?.status === 'done') ? st : undefined;
    }, 'goal reached', 15_000);

    const msgs = s.conversation.messages.filter((m) => m.role !== 'system');
    assert.deepEqual(
      msgs.map((m) => [m.kind ?? 'user', m.agent ?? 'ceo', m.iteration ?? 0]),
      [
        ['user', 'ceo', 0],
        ['plan', 'claude', 1],
        ['task', 'codex', 1],
        ['task', 'gemini', 1],
        ['report', 'claude', 1],
        ['task', 'codex', 2],
        ['report', 'claude', 2],
      ],
    );
    const [first, second] = msgs.filter((m) => m.kind === 'report');
    assert.equal(first.teamStatus?.status, 'continue');
    assert.deepEqual(first.plan?.map((t) => [t.id, t.status]), [['b1', 'done']]);
    assert.ok(!first.parts.some((p: any) => p.type === 'text' && p.text.includes('```team-')), 'blocks are hidden');
    assert.ok(msgs[5].subtitle?.startsWith('итерация 2 · 1/1'));
    assert.equal(msgs[5].replyTo, first.id);
    assert.equal(second.teamStatus?.status, 'done');
    assert.ok(msgs.slice(1).every((m) => m.goal === msgs[0].id));
    assert.ok(!s.conversation.messages.some((m) => m.role === 'system'), 'no stop notices');
  } finally {
    dispose();
  }
});

test('autopilot: stops at the iteration limit; «Ещё итерация» runs the plan the lead already made', async () => {
  const { webview, last, dispose } = startHost({
    'harness.agents.claude.path': fakeCliSeq(AUTOPILOT_SEQ),
    'harness.team.maxIterations': 1,
  });
  try {
    webview.send({ type: 'ready' });
    await until(() => (last()?.agents.every((a) => a.installed) ? last() : undefined), 'agents detected');
    webview.send({ type: 'send', text: 'Сделайте API и макеты', prefs: TEAM_PREFS });
    let s = await until(() => {
      const st = last();
      return st && !st.running && st.conversation.messages.some((m) => m.role === 'system') ? st : undefined;
    }, 'stopped at the limit');
    const report = s.conversation.messages.find((m) => m.kind === 'report')!;
    assert.match(messageTextOf(s.conversation.messages.find((m) => m.role === 'system')!), /лимит итераций \(1\)/);
    assert.deepEqual(report.plan?.map((t) => t.status), ['pending']);

    webview.send({ type: 'continueTeam', id: report.id });
    s = await until(() => {
      const st = last();
      return st && !st.running && st.conversation.messages.some((m) => m.teamStatus?.status === 'done') ? st : undefined;
    }, 'continued to the goal');
    const continued = s.conversation.messages.find((m) => m.id === report.id)!;
    assert.deepEqual(continued.plan?.map((t) => t.status), ['done']);
    assert.equal(s.conversation.messages.filter((m) => m.kind === 'plan').length, 1, 'no re-planning: the ready plan was used');
  } finally {
    dispose();
  }
});

test('quota: the header shows what each CLI reports; a click on a card re-reads it', async () => {
  const { webview, last, dispose } = startHost({
    'harness.agents.claude.path': fakeReplyCli('claude-usage.json'),
    'harness.agents.codex.path': fakeReplyCli('codex-app-server.jsonl'),
    'harness.agents.gemini.path': fakeReplyCli('agy-usage.json'),
  });
  try {
    webview.send({ type: 'ready' });
    const limits = () => {
      const agents = last()?.agents;
      return agents?.every((a) => a.limits) ? Object.fromEntries(agents.map((a) => [a.id, a.limits!])) : undefined;
    };
    const first = await until(limits, 'quota of all three agents');
    assert.equal(first.claude.fiveHour?.usedPercent, 44);
    assert.equal(first.codex.fiveHour, null, 'Codex on Pro: no 5-hour window');
    assert.equal(first.codex.weekly?.usedPercent, 2);
    assert.equal(Math.round(first.gemini.weekly!.usedPercent), 6);

    webview.send({ type: 'command', command: 'limits' });
    await until(() => limits()!.gemini.updatedAt > first.gemini.updatedAt || undefined, 're-read on click');
  } finally {
    dispose();
  }
});

function messageTextOf(m: { parts: any[] }): string {
  return m.parts.map((p) => p.text ?? '').join('');
}
