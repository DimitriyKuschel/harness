// Manual end-to-end check of the orchestrator without VS Code (spends a little quota):
//   node dist-test/orch-smoke.js          routing + brainstorm in the current folder
//   node dist-test/orch-smoke.js team DIR  team mode (eco, read-only) in DIR
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../core/agents/claude';
import { CodexAdapter } from '../core/agents/codex';
import { GeminiAdapter } from '../core/agents/gemini';
import { Orchestrator } from '../core/orchestrator';
import { Router } from '../core/router';
import { AGENT_LABELS, messageText, type AgentId, type Prefs } from '../core/types';

const log = { info: (m: string) => console.error('  [log]', m.slice(0, 200)), error: (m: string) => console.error('  [err]', m) };
const adapters = { claude: new ClaudeAdapter(() => 'claude', log), codex: new CodexAdapter(() => 'codex', log), gemini: new GeminiAdapter(() => 'agy', log) };
const scratch = mkdtempSync(join(tmpdir(), 'harness-'));
const pkg = require('../../package.json');
const defaults = pkg.contributes.configuration.properties;
const router = new Router(
  () => ({ classifier: 'llm', affinity: defaults['harness.routing.affinity'].default, models: defaults['harness.models'].default, strengths: defaults['harness.strengths'].default }),
  adapters,
  () => scratch,
);
const limits: any = {};
const orch = new Orchestrator({
  adapters, router, log,
  cwd: () => process.argv[3] ?? process.cwd(),
  available: () => ['claude', 'codex', 'gemini'] as AgentId[],
  limits: () => limits,
  onLimits: (a, l) => (limits[a] = l),
  onExhausted: (a, e) => (limits[a] = { ...limits[a], exhausted: e, updatedAt: Date.now() }),
  onRunEnd: () => {},
  onChange: () => {},
  onSettled: () => {},
  maxIterations: () => 3,
  maxHandoffs: () => 3,
  hasQueued: () => false,
});

const eco: Prefs = { mode: 'auto', profile: 'eco', autonomy: 'readonly', autopilot: true };
const dump = (from: number) =>
  orch.conversation.messages.slice(from).forEach((m) => {
    const who = m.role === 'user' ? 'CEO' : m.role === 'system' ? 'SYS' : AGENT_LABELS[m.agent!];
    const r = m.route ? ` [${m.route.model}/${m.route.effort} ${m.route.tier}/${m.route.domain} via ${m.route.via}: ${m.route.reason}]` : '';
    const tools = m.parts.filter((p) => p.type === 'tool').length;
    console.log(`\n### ${who} ${m.kind ?? ''} ${m.status}${r}${tools ? ` tools=${tools}` : ''}\n${messageText(m).slice(0, 700)}${m.error ? `\nERROR: ${m.error}` : ''}`);
  });

void (async () => {
  let n = 0;
  const step = async (title: string, fn: () => Promise<void>) => {
    console.log(`\n================ ${title}`);
    const t = Date.now();
    await fn();
    dump(n);
    n = orch.conversation.messages.length;
    console.log(`(${((Date.now() - t) / 1000).toFixed(1)}s)`);
  };
  if (process.argv[2] === 'autopilot') {
    await step('autopilot: iterate until npm test passes', () =>
      orch.send(
        'Добавьте в сервер эндпоинт DELETE /tasks/:id и автотесты на node:test для GET, POST и DELETE (сервер должен экспортироваться так, чтобы его можно было поднять в тесте на свободном порту). Цель достигнута, когда `npm test` проходит. Распределите работу между собой.',
        { ...eco, mode: 'team', autonomy: 'auto' },
      ),
    );
    for (const m of orch.conversation.messages.filter((x) => x.plan || x.teamStatus)) {
      console.log(`\n${m.kind} it=${m.iteration} status=${JSON.stringify(m.teamStatus)} tasks=${JSON.stringify(m.plan?.map((t) => [t.id, t.agent, t.status]))}`);
    }
    console.log('LIMITS', JSON.stringify(limits));
    return;
  }
  if (process.argv[2] === 'team') {
    await step('team: plan → tasks → report', () =>
      orch.send(
        'Распределите работу между собой, каждому по одной части: (1) опишите архитектуру этого проекта, (2) предложите 3 названия продукта, (3) предложите палитру из 3 цветов для логотипа. Каждая часть — до 5 строк.',
        { ...eco, mode: 'team' },
      ),
    );
    const plan = orch.conversation.messages.find((m) => m.kind === 'plan');
    console.log('\nPLAN', JSON.stringify(plan?.plan?.map((t) => ({ id: t.id, agent: t.agent, tier: t.tier, status: t.status, deps: t.dependsOn, title: t.title })), null, 1));
    console.log('LIMITS', JSON.stringify(limits));
    return;
  }
  await step('auto-route to gemini (design)', () => orch.send('Придумай цветовую палитру из 3 цветов для иконки этого плагина. Только HEX и по 3 слова на цвет.', eco));
  await step('brainstorm x3', () => orch.send('Какую одну фичу добавить в этот плагин следующей? Очень кратко.', { ...eco, mode: 'brainstorm' }));
  console.log('\nSESSIONS', JSON.stringify(orch.conversation.sessions));
  console.log('LIMITS', JSON.stringify(limits));
})();
