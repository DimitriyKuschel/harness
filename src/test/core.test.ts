import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { fakeCli, fakeReplyCli } from './helpers';
import { ClaudeAdapter, parseClaudeLimits, parseClaudeUsage } from '../core/agents/claude';
import { CodexAdapter, parseCodexModels, parseCodexRateLimits } from '../core/agents/codex';
import { GeminiAdapter, parseAgyModels } from '../core/agents/gemini';
import { resolveLocale, setLocale } from '../i18n';
import { discussionTier, handoffMentions, parseMentions, teamBrief } from '../core/orchestrator';
import { parsePlan, parseStatus, stripPlanBlock } from '../core/plan';
import { exhaustedUntil, quotaError } from '../core/quota';
import { Router, effectiveUsage, heuristicAssessment, isSmallTalk, quotaPenalty, shiftTier, type RouteContext, type RouterConfig } from '../core/router';
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

test('heuristics: english', () => {
  assert.equal(heuristicAssessment('what is this project?').tier, 'trivial');
  assert.ok(isSmallTalk('thanks!'));
  assert.ok(!isSmallTalk('ok, add tests'));
  assert.equal(heuristicAssessment('Design the architecture of the payment module and the data migration').tier, 'hard');
  assert.equal(heuristicAssessment('this is a critical question: can you keep working on your part?').tier, 'critical');
  assert.equal(heuristicAssessment('this is not critical, take a look when you have time').tier, 'trivial');
  const ui = heuristicAssessment('add a login button to the home page');
  assert.deepEqual([ui.tier, ui.domain, ui.needsChanges], ['standard', 'frontend', true]);
  assert.equal(heuristicAssessment('Suggest an SEO strategy and an advertising campaign for the launch').domain, 'marketing');
  assert.ok(heuristicAssessment('go ahead, split the work among yourselves').team);
  assert.ok(!heuristicAssessment('add user roles to the admin panel').team);
});

test('i18n: the locale follows the setting or VS Code; prompts, strengths and labels switch with it', () => {
  assert.equal(resolveLocale('auto', 'ru'), 'ru');
  assert.equal(resolveLocale('auto', 'en-US'), 'en');
  assert.equal(resolveLocale('auto', 'de'), 'en');
  assert.equal(resolveLocale('ru', 'en'), 'ru');
  assert.equal(resolveLocale(undefined, 'en'), 'en');

  assert.match(teamBrief('codex', '/p'), /^You are Codex, a member/);
  assert.match(router.roster(ctx()), /- Claude \(agent: "claude"\): architecture and complex .* Subscription limit used: 0%\./);
  const custom = new Router(() => ({ ...config, strengths: { codex: 'only tests' } }), {} as never, () => tmpdir());
  assert.match(custom.roster(ctx()), /"codex"\): only tests /);
  assert.match(custom.roster(ctx()), /"claude"\): architecture and complex/);

  setLocale('ru');
  try {
    assert.match(teamBrief('codex', '/p'), /^Ты — Codex, участник/);
    assert.match(router.roster(ctx()), /архитектура и сложные .* Лимит подписки израсходован на 0%\./);
    assert.equal(heuristicAssessment('').reason, 'эвристика по тексту');
  } finally {
    setLocale('en');
  }
  assert.equal(heuristicAssessment('').reason, 'text heuristics');
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
  assert.equal(tasks[1].title, 'Task 2');
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

test('quota errors: each CLI\'s wording, and when the quota comes back', () => {
  const now = new Date(2026, 9, 25, 12, 0).getTime();
  const nowS = now / 1000;
  const agy = quotaError('Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 163h58m6s.', now);
  assert.deepEqual(agy, { until: nowS + 163 * 3600 + 58 * 60 + 6, known: true });
  const codex = quotaError("You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 days 3 hours 4 minutes.", now);
  assert.equal(codex?.until, nowS + 2 * 86400 + 3 * 3600 + 4 * 60);
  const codexAt = quotaError("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Oct 27th, 2026 3:04 PM.", now);
  assert.equal(codexAt?.until, new Date(2026, 9, 27, 15, 4).getTime() / 1000);
  const codexToday = quotaError("You've hit your usage limit. Try again at 9:30 AM.", now);
  assert.equal(codexToday?.until, new Date(2026, 9, 26, 9, 30).getTime() / 1000, 'a time already past today is tomorrow');
  const claude = quotaError('5-hour limit reached ∙ resets 3pm (Europe/Moscow)', now);
  assert.equal(claude?.until, new Date(2026, 9, 25, 15, 0).getTime() / 1000);
  const claudeWeek = quotaError("You've hit your limit · resets Oct 30, 9am", now);
  assert.equal(claudeWeek?.until, new Date(2026, 9, 30, 9, 0).getTime() / 1000);
  assert.equal(quotaError('Claude AI usage limit reached|1793000000', now)?.until, 1793000000);
  assert.deepEqual(quotaError('RESOURCE_EXHAUSTED: quota exceeded', now), { until: nowS + 3600, known: false });
  assert.deepEqual(quotaError('429 Too Many Requests', now), { until: nowS + 300, known: false });
  assert.equal(quotaError('session not found', now), undefined);
  assert.equal(quotaError('Нет разрешения на: run_command — попробуйте режим «Правки»', now), undefined);
  assert.equal(quotaError(undefined, now), undefined);
});

test('quota: an agent whose run hit the quota sits out until the reset, whatever its windows say', () => {
  const l: AgentLimits = { weekly: { usedPercent: 1, resetsAt: now() + 86400 }, exhausted: { until: now() + 3600, message: 'quota' }, updatedAt: 0 };
  assert.equal(exhaustedUntil(l), now() + 3600);
  assert.equal(effectiveUsage(l), 100);
  assert.ok(quotaPenalty(l) >= 100);
  assert.equal(router.pickAgent({ domain: 'code' }, ctx({ codex: l })), 'claude');
  const lifted = { ...l, exhausted: { until: now() - 1, message: 'quota' } };
  assert.equal(exhaustedUntil(lifted), undefined);
  assert.equal(effectiveUsage(lifted), 1);
});

test('models: pins override the tier table; the lead sees models per tier; plans may name a model', () => {
  const c: RouteContext = { ...ctx(), profile: 'balanced', autonomy: 'auto', recent: '', cwd: '', models: { gemini: 'gemini-3.8-flash-high' } };
  const pinned = router.forAgent('gemini', 'критическая задача', c);
  assert.equal(pinned.model, 'gemini-3.8-flash-high');
  assert.equal(pinned.tier, 'critical');
  assert.equal(router.forAgent('claude', 'критическая задача', c).model, 'opus');
  const roster = router.roster({ available: ['claude', 'gemini'], limits: {}, models: c.models });
  assert.match(roster, /Claude.*trivial → haiku, standard → sonnet, hard → opus, critical → opus/);
  assert.match(roster, /Gemini.*gemini-3\.8-flash-high for every tier \(pinned by the CEO\)/);
  const plan = '```team-plan\n{"tasks": [{"id": "a", "agent": "gemini", "task": "x", "model": "gemini-3.8-flash-high"}, {"id": "b", "agent": "gemini", "task": "y", "model": "--yolo"}]}\n```';
  assert.deepEqual(parsePlan(plan, (_, w) => w as AgentId)!.map((t) => t.model), ['gemini-3.8-flash-high', undefined]);
});

test('models: lists to pin from each CLI', () => {
  assert.deepEqual(parseAgyModels('Fetching available models...\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-opus-5-5-low\tClaude Opus 5.5 (Low)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n'), [
    'gemini-4-argon-high',
    'gemini-3.8-flash-low',
  ]);
  assert.deepEqual(
    parseCodexModels({ models: [{ slug: 'gpt-6-luna', priority: 5, visibility: 'list' }, { slug: 'gpt-reserve', priority: 4, visibility: 'hide' }, { slug: 'gpt-6.1-sol', priority: 1, visibility: 'list' }] }),
    ['gpt-6.1-sol', 'gpt-6-luna'],
  );
  assert.deepEqual(parseCodexModels(undefined), []);
});

test('gemini (agy) adapter: a resumed conversation reports this run\'s tokens, not the whole conversation\'s', async () => {
  const run = (sessionId?: string) =>
    new GeminiAdapter(() => fakeCli('gemini-resumed.jsonl')).run({ prompt: 'x', cwd: '/data/harness', autonomy: 'readonly', sessionId }, () => {}, new AbortController().signal);
  const resumed = await run('f11ee94a-190a-45c1-9436-ca8bca53ae17');
  assert.ok(resumed.ok, resumed.error);
  assert.deepEqual(resumed.usage, { input: 8672, output: 2, cached: 0 }, 'the result says 16342: both runs of the conversation');

  const failed = await new GeminiAdapter(() => fakeCli('gemini-quota.jsonl')).run(
    { prompt: 'x', cwd: '/data/harness', autonomy: 'auto', sessionId: 'old' },
    () => {},
    new AbortController().signal,
  );
  assert.equal(failed.ok, false);
  assert.match(failed.error ?? '', /^Individual quota reached/);
  assert.deepEqual(failed.usage, { input: 120000, output: 1200, cached: 0 });
});
