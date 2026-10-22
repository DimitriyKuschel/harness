import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fakeCli, fakeReplyCli } from './helpers';
import { ClaudeAdapter, parseClaudeLimits, parseClaudeUsage } from '../core/agents/claude';
import { CodexAdapter, parseCodexRateLimits } from '../core/agents/codex';
import { GeminiAdapter } from '../core/agents/gemini';
import { discussionTier, handoffMentions, parseMentions } from '../core/orchestrator';
import { parsePlan, parseStatus, stripPlanBlock } from '../core/plan';
import { Router, effectiveUsage, heuristicAssessment, isSmallTalk, shiftTier, type RouteContext, type RouterConfig } from '../core/router';
import type { AgentEvent, AgentId, AgentLimits } from '../core/types';

const pkg = require('../../package.json');
const props = pkg.contributes.configuration.properties;
const config: RouterConfig = {
  classifier: 'heuristic',
  affinity: props['harness.routing.affinity'].default,
  models: props['harness.models'].default,
  strengths: props['harness.strengths'].default,
};
const router = new Router(() => config, {} as never, () => tmpdir());
const ctx = (limits: Partial<Record<AgentId, AgentLimits>> = {}) => ({ available: ['claude', 'codex'] as AgentId[], limits, busy: new Set<AgentId>() });
const now = () => Math.floor(Date.now() / 1000);

test('mentions: latin and cyrillic aliases; emails are not mentions', () => {
  assert.deepEqual(parseMentions('@claude и @кодекс, гляньте'), { agents: ['claude', 'codex'], all: false });
  assert.deepEqual(parseMentions('@все обсудим'), { agents: [], all: true });
  assert.deepEqual(parseMentions('пиши на team@codex.dev'), { agents: [], all: false });
});

test('handoff mentions: an agent addresses colleagues in prose, not in code or quotes', () => {
  const reply = ['Готово.', '```sh\n@gemini run\n```', '> @claude, как просил CEO', '## @Codex: проверь `src/a.ts`'].join('\n');
  assert.deepEqual(handoffMentions(reply), { agents: ['codex'], all: false });
  assert.deepEqual(handoffMentions('`@claude`, `@gemini` — изучите документ'), { agents: ['claude', 'gemini'], all: false });
  assert.deepEqual(handoffMentions('пакет @nuxt/ui и admin@example.local'), { agents: [], all: false });
});

test('heuristics: tier, domain, change intent', () => {
  assert.equal(heuristicAssessment('что это за проект?').tier, 'trivial');
  assert.ok(isSmallTalk('спасибо!'));
  assert.ok(!isSmallTalk('ок, добавь тесты'));
  assert.equal(heuristicAssessment('Спроектируй архитектуру модуля оплаты и миграцию данных').tier, 'hard');
  assert.equal(heuristicAssessment('вопрос критический, ты можешь продолжать свою часть работы или нет?').tier, 'critical');
  assert.equal(heuristicAssessment('это не критично, глянь когда будет время').tier, 'trivial');
  const ui = heuristicAssessment('добавь кнопку логина на главную страницу');
  assert.deepEqual([ui.tier, ui.domain, ui.needsChanges], ['standard', 'frontend', true]);
  assert.equal(heuristicAssessment('Предложи SEO стратегию и рекламу для запуска продукта').domain, 'marketing');
  assert.ok(heuristicAssessment('можете начинать, роли распределите сами').team);
  assert.ok(!heuristicAssessment('добавь роли пользователей в админку').team);
});

test('team plan: parsed, sanitised, hidden from the chat', () => {
  const text = [
    'Подход: бэкенд — Codex.',
    '```team-plan',
    JSON.stringify({
      tasks: [
        { id: 'a', title: 'API', agent: 'codex', domain: 'code', tier: 'hard', task: 'сделай API', dependsOn: ['b', 'a', 'zzz'] },
        { id: 'b', agent: 'grok', domain: 'design', task: 'макеты' },
        { id: 'c', agent: 'claude', task: '' },
      ],
    }),
    '```',
  ].join('\n');
  const tasks = parsePlan(text, (domain, wanted) => (wanted === 'codex' || wanted === 'claude' ? wanted : domain === 'design' ? 'gemini' : undefined))!;
  assert.deepEqual(
    tasks.map((t) => [t.id, t.agent, t.tier, t.dependsOn]),
    [
      ['a', 'codex', 'hard', ['b']],
      ['b', 'gemini', 'standard', []],
    ],
  );
  assert.equal(tasks[1].title, 'Задача 2');
  assert.equal(stripPlanBlock(text), 'Подход: бэкенд — Codex.');
  assert.equal(stripPlanBlock('План:\n```team-plan\n{"tasks": ['), 'План:');
  assert.equal(parsePlan('```team-plan\n{oops\n```', () => 'claude'), undefined);
  assert.equal(parsePlan('без плана', () => 'claude'), undefined);

  const report = 'Итог.\n```team-plan\n{"tasks": []}\n```\n```team-status\n{"status": "blocked", "reason": "нужен доступ к GitLab"}\n```';
  assert.deepEqual(parseStatus(report), { status: 'blocked', reason: 'нужен доступ к GitLab' });
  assert.equal(stripPlanBlock(report), 'Итог.');
  assert.deepEqual(parsePlan(report, () => 'claude'), []);
  assert.equal(parseStatus('```team-status\n{"status": "maybe"}\n```'), undefined);
});

test('profile shifts the tier within bounds', () => {
  assert.equal(shiftTier('standard', 'eco'), 'trivial');
  assert.equal(shiftTier('trivial', 'eco'), 'trivial');
  assert.equal(shiftTier('hard', 'max'), 'critical');
  assert.equal(shiftTier('critical', 'max'), 'critical');
});

test('router: affinity first, spent quota shifts work to colleagues', () => {
  assert.equal(router.pickAgent({ domain: 'code' }, ctx()), 'codex');
  assert.equal(router.pickAgent({ domain: 'writing' }, ctx()), 'claude');
  const all = (limits = {}) => ({ ...ctx(limits), available: ['claude', 'codex', 'gemini'] as AgentId[] });
  assert.equal(router.pickAgent({ domain: 'frontend' }, all()), 'claude');
  const busyWeek = { claude: { weekly: { usedPercent: 65, resetsAt: now() + 86400 }, updatedAt: 0 } };
  assert.equal(router.pickAgent({ domain: 'frontend' }, all(busyWeek)), 'gemini');
  const exhausted = { codex: { fiveHour: { usedPercent: 99, resetsAt: now() + 3600 }, updatedAt: 0 } };
  assert.equal(router.pickAgent({ domain: 'code' }, ctx(exhausted)), 'claude');
  const reset = { codex: { fiveHour: { usedPercent: 99, resetsAt: now() - 10 }, updatedAt: 0 } };
  assert.equal(router.pickAgent({ domain: 'code' }, ctx(reset)), 'codex');
  assert.equal(router.pickAgent({ domain: 'code' }, ctx(), ['codex']), 'claude');
});

test('router: tier maps to model and effort', () => {
  assert.deepEqual(router.modelFor('claude', 'trivial'), { model: 'haiku', effort: 'low' });
  assert.deepEqual(router.modelFor('codex', 'critical'), { model: 'gpt-6-astra', effort: 'high' });
  assert.deepEqual(router.modelFor('gemini', 'standard'), { model: 'gemini-4-argon-low', effort: 'low' });
});

test('router: a mention keeps the tier of the agent\'s ongoing work', () => {
  const c: RouteContext = { ...ctx(), profile: 'balanced', autonomy: 'auto', recent: '', cwd: '' };
  const followUp = 'ты можешь продолжать свою часть работы или нет?';
  assert.equal(router.forAgent('gemini', followUp, c).model, 'gemini-3.8-flash-low');
  assert.equal(router.forAgent('gemini', followUp, c, undefined, 'hard').model, 'gemini-4-argon-medium');
  assert.equal(router.forAgent('gemini', 'спасибо!', c, undefined, 'hard').tier, 'trivial');
  assert.equal(router.forAgent('gemini', `вопрос критический, ${followUp}`, c, undefined, 'standard').model, 'gemini-4-argon-high');
  assert.equal(router.forAgent('gemini', followUp, { ...c, profile: 'max' }).tier, 'standard');
});

test('discussions and reviews run on strong models', () => {
  assert.equal(discussionTier('как назвать проект?', 'balanced'), 'hard');
  assert.equal(router.modelFor('gemini', discussionTier('как назвать проект?', 'balanced')).model, 'gemini-4-argon-medium');
  assert.equal(discussionTier('критический выбор архитектуры', 'balanced'), 'critical');
  assert.equal(discussionTier('как назвать проект?', 'max'), 'critical');
  assert.equal(discussionTier('как назвать проект?', 'eco'), 'standard');
});

test('limits parsing', () => {
  const c = parseClaudeLimits({ unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: 1 }, seven_day: { utilization: 0.1, resetsAt: 2 } } });
  assert.equal(Math.round(c!.fiveHour!.usedPercent), 42);
  assert.equal(Math.round(c!.weekly!.usedPercent), 10);
  const x = parseCodexRateLimits({ primary: { used_percent: 12, window_minutes: 300, resets_at: 5 }, secondary: { used_percent: 3, window_minutes: 10080, resets_at: 6 } });
  assert.deepEqual([x!.fiveHour!.usedPercent, x!.weekly!.usedPercent], [12, 3]);
  // Codex on Pro (app-server answers in camelCase): one weekly window, no 5-hour one.
  const pro = parseCodexRateLimits({ primary: { usedPercent: 30, windowDurationMins: 10080, resetsAt: 7 }, secondary: null });
  assert.equal(pro!.fiveHour, null);
  assert.deepEqual(pro!.weekly, { usedPercent: 30, resetsAt: 7 });
  assert.equal(effectiveUsage(pro, 0), 30);
});

test('quota: read through each CLI without a model call', async () => {
  const claude = await new ClaudeAdapter(() => fakeReplyCli('claude-usage.json')).readLimits();
  assert.deepEqual([claude?.fiveHour?.usedPercent, claude?.weekly?.usedPercent], [44, 7]);
  const codex = await new CodexAdapter(() => fakeReplyCli('codex-app-server.jsonl')).readLimits();
  assert.equal(codex?.fiveHour, null, 'no 5-hour window on this plan');
  assert.deepEqual(codex?.weekly, { usedPercent: 2, resetsAt: 1792951824 });
  const gemini = await new GeminiAdapter(() => fakeReplyCli('agy-usage.json')).readLimits();
  assert.deepEqual([Math.round(gemini!.fiveHour!.usedPercent), Math.round(gemini!.weekly!.usedPercent)], [19, 6], 'the Gemini group, not Claude/GPT');
  assert.equal(gemini!.weekly!.resetsAt, Date.parse('2026-10-25T18:05:38Z') / 1000);
});

test('quota: reset times in Claude /usage', () => {
  const at = (...d: [number, number, number, number, number]) => new Date(...d).getTime() / 1000;
  const l = parseClaudeUsage('Current session: 41% used · resets Oct 18, 10:50pm (UTC)\nCurrent week (all models): 7% used · resets Oct 22, 1pm (UTC)', new Date(2026, 9, 18, 20, 0));
  assert.deepEqual(l!.fiveHour, { usedPercent: 41, resetsAt: at(2026, 9, 18, 22, 50) });
  assert.deepEqual(l!.weekly, { usedPercent: 7, resetsAt: at(2026, 9, 22, 13, 0) });
  const newYear = parseClaudeUsage('Current week (all models): 3% used · resets Jan 2, 12am (UTC)', new Date(2026, 11, 30, 12, 0));
  assert.equal(newYear!.weekly!.resetsAt, at(2027, 0, 2, 0, 0));
  assert.equal(newYear!.fiveHour, undefined, 'a window missing from the text stays unknown');
  assert.equal(parseClaudeUsage('You are using an API key'), undefined);
});

test('claude adapter: replays a recorded stream', async () => {
  const events: AgentEvent[] = [];
  const out = await new ClaudeAdapter(() => fakeCli('claude-stream.jsonl')).run(
    { prompt: 'x', cwd: '/data/harness', autonomy: 'readonly' },
    (e) => events.push(e),
    new AbortController().signal,
  );
  assert.ok(out.ok, out.error);
  assert.equal(out.text, '0.1.0');
  assert.ok(out.sessionId);
  const streamed = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('');
  assert.equal(streamed, '0.1.0', 'text arrives once, via deltas');
  assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'Read' && e.detail === 'package.json'));
  assert.ok(events.some((e) => e.kind === 'tool_done' && e.ok));
  assert.ok(events.some((e) => e.kind === 'limits'));
});

test('codex adapter: replays a recorded stream', async () => {
  const events: AgentEvent[] = [];
  const out = await new CodexAdapter(() => fakeCli('codex-stream.jsonl')).run(
    { prompt: 'x', cwd: '/data/harness', autonomy: 'readonly', ephemeral: true },
    (e) => events.push(e),
    new AbortController().signal,
  );
  assert.ok(out.ok, out.error);
  assert.equal(out.text, 'icon.svg');
  assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'Shell'));
  assert.ok(events.some((e) => e.kind === 'tool_done' && e.ok));
  assert.ok(out.usage && out.usage.input > 0);
});

test('gemini (agy) adapter: replays a recorded stream', async () => {
  const events: AgentEvent[] = [];
  const out = await new GeminiAdapter(() => fakeCli('gemini-stream.jsonl')).run(
    { prompt: 'x', cwd: '/data/harness', autonomy: 'auto', model: 'gemini-3.8-flash-low' },
    (e) => events.push(e),
    new AbortController().signal,
  );
  assert.ok(out.ok, out.error);
  assert.equal(out.text, 'icon.svg');
  assert.ok(out.sessionId);
  assert.ok(events.some((e) => e.kind === 'tool' && e.name === 'run_command' && e.detail === 'ls media'));
  assert.ok(events.some((e) => e.kind === 'tool_done' && e.ok));
  assert.ok(events.some((e) => e.kind === 'model'));
});
