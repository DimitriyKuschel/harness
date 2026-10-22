// Sample ViewState for the dev preview: every message state the UI has to render.
function sampleState(empty) {
  const t0 = Date.now() - 18 * 60_000;
  const at = (min) => t0 + min * 60_000;
  const reset5h = Math.floor(Date.now() / 1000) + 2 * 3600;
  const resetWeek = Math.floor(Date.now() / 1000) + 4 * 86400;
  const text = (s) => ({ type: 'text', text: s });
  const tool = (id, name, detail, status = 'ok') => ({ type: 'tool', id, name, detail, status });

  const messages = [
    { id: 'u1', role: 'user', status: 'done', createdAt: at(0), parts: [text('Добавь в API healthcheck-эндпоинт и покрой его тестами')] },
    {
      id: 'a1', role: 'agent', agent: 'codex', kind: 'answer', replyTo: 'u1', status: 'done', createdAt: at(0.1), endedAt: at(1.6),
      route: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', tier: 'standard', domain: 'code', autonomy: 'auto', via: 'llm', reason: 'небольшая фича в бэкенде с тестами' },
      usage: { input: 48210, output: 2310, cached: 30500 },
      parts: [
        tool('t1', 'Shell', "/bin/bash -lc 'rg -n \"router\" src | head'"),
        tool('t2', 'Edit', 'src/routes/health.ts'),
        tool('t3', 'Edit', 'src/routes/index.ts'),
        tool('t4', 'Edit', 'test/health.test.ts'),
        tool('t5', 'Shell', "/bin/bash -lc 'npm test -- health'"),
        text(
          'Готово. Добавил `GET /health`, он возвращает статус и версию:\n\n```ts\nrouter.get(\'/health\', (_req, res) => {\n  res.json({ status: \'ok\', version: pkg.version, uptime: process.uptime() });\n});\n```\n\n- Роут: `src/routes/health.ts:1`\n- Подключение: `src/routes/index.ts:14`\n- Тесты: `test/health.test.ts`, 3 кейса, все зелёные.',
        ),
      ],
    },
    {
      id: 'r1', role: 'agent', agent: 'claude', kind: 'review', replyTo: 'a1', status: 'done', createdAt: at(2), endedAt: at(2.7),
      route: { agent: 'claude', model: 'sonnet', resolvedModel: 'claude-sonnet-5-5', effort: 'medium', tier: 'standard', domain: 'code', autonomy: 'readonly', via: 'system', reason: 'ревью ответа Codex' },
      usage: { input: 39120, output: 640 },
      parts: [
        tool('c1', 'Bash', 'git diff --stat'),
        tool('c2', 'Read', 'src/routes/health.ts'),
        text('⚠️ **Есть замечания**\n\n1. `src/routes/health.ts:3`: `uptime` раскрывает время работы процесса публично. Для внешнего healthcheck лучше отдавать только `status`.\n2. Нет проверки зависимостей (БД, кэш). Стоит добавить `/health/ready` для оркестратора.\n3. Тесты не проверяют заголовок `Cache-Control: no-store`.'),
      ],
    },
    { id: 'u2', role: 'user', status: 'done', createdAt: at(4), parts: [text('Как лучше организовать мониторинг сервиса после запуска? Бюджет минимальный.')] },
    {
      id: 'b1', role: 'agent', agent: 'claude', kind: 'brainstorm', round: 'R1', replyTo: 'u2', status: 'done', createdAt: at(4.1), endedAt: at(5),
      route: { agent: 'claude', model: 'sonnet', effort: 'medium', tier: 'standard', domain: 'planning', autonomy: 'readonly', via: 'system', reason: 'брейншторм' },
      usage: { input: 31000, output: 820 },
      parts: [text('**Подход:** начать с бесплатного стека и метрик «четырёх золотых сигналов».\n\n**Варианты:**\n1. **Uptime Kuma** на самом дешёвом VPS: пинги, алерты в Telegram.\n2. **Grafana Cloud Free**: 10k метрик и 50 ГБ логов бесплатно, готовые дашборды.\n3. **Sentry Free** для ошибок фронта и бэка.\n\n**Риски:** у бесплатных тарифов маленький retention, а алерты из одного места создают единую точку отказа.\n\n**Рекомендация:** Kuma для внешних проверок и Grafana Cloud для метрик и логов. Пересмотреть через месяц по фактической нагрузке.\n\n'.repeat(1))],
    },
    {
      id: 'b2', role: 'agent', agent: 'codex', kind: 'brainstorm', round: 'R1', replyTo: 'u2', status: 'done', createdAt: at(4.1), endedAt: at(4.8),
      route: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', tier: 'standard', domain: 'planning', autonomy: 'readonly', via: 'system', reason: 'брейншторм' },
      usage: { input: 27000, output: 540 },
      parts: [text('**Идея:** OpenTelemetry с первого дня, чтобы не было vendor lock-in.\n\n- SDK OTel в сервис, экспорт в Grafana Cloud.\n- `/health` и `/health/ready` уже есть, повесить на них синтетику.\n- Алерты: p95 latency, error rate > 1%, saturation CPU/RAM.\n\n**Рекомендация:** OTel + Grafana Cloud Free, без самописных решений.')],
    },
    {
      id: 's1', role: 'agent', agent: 'claude', kind: 'synthesis', round: 'R1', replyTo: 'u2', status: 'done', createdAt: at(5.1), endedAt: at(5.5),
      route: { agent: 'claude', model: 'sonnet', effort: 'medium', tier: 'standard', domain: 'planning', autonomy: 'readonly', via: 'system', reason: 'модератор: сводка мнений' },
      usage: { input: 3100, output: 410 },
      parts: [text('**Консенсус:** Grafana Cloud Free как основа метрик и логов, алерты по error rate и латентности.\n\n**Расхождения:** Claude предлагает Uptime Kuma для внешних проверок, Codex предлагает OpenTelemetry с первого дня.\n\n**Рекомендация:** OTel SDK → Grafana Cloud; внешний пинг — встроенная синтетика Grafana (без отдельного VPS).\n\n**Вопросы к CEO:** нужен ли мониторинг фронтенда (Sentry) уже на старте?')],
    },
    { id: 'n1', role: 'system', kind: 'notice', status: 'done', createdAt: at(6), parts: [text('Недоступны: Gemini — пропускаю.')] },
    { id: 'u3', role: 'user', status: 'done', createdAt: at(7), parts: [text('Ок, внедряй OTel по рекомендации. Sentry пока не нужен.')] },
    {
      id: 'a3', role: 'agent', agent: 'claude', kind: 'answer', replyTo: 'u3', status: 'streaming', createdAt: Date.now() - 47_000,
      route: { agent: 'claude', model: 'opus', effort: 'high', tier: 'hard', domain: 'code', autonomy: 'auto', via: 'llm', reason: 'интеграция телеметрии во весь сервис' },
      parts: [
        text('Начну с зависимостей и инициализации SDK, затем добавлю экспорт.'),
        tool('d1', 'Read', 'package.json'),
        tool('d2', 'Write', 'src/telemetry.ts'),
        tool('d3', 'Bash', 'npm install @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node', 'running'),
      ],
    },
    {
      id: 'e1', role: 'agent', agent: 'codex', kind: 'answer', replyTo: 'u3', status: 'error', createdAt: at(7.2), endedAt: at(7.3),
      route: { agent: 'codex', model: 'gpt-6-luna', effort: 'low', tier: 'trivial', domain: 'code', autonomy: 'auto', via: 'mention', reason: 'по упоминанию' },
      parts: [],
      error: 'You have hit your usage limit. Try again in 42 minutes.',
    },
  ];

  // ?team=1: a team run in progress (plan card, parallel tasks).
  const teamMode = new URLSearchParams(location.search).has('team');
  const plan = [
    { id: 't1', title: 'API задач и проектов на Go', agent: 'codex', domain: 'code', tier: 'hard', scope: 'backend/', dependsOn: [], status: 'done', messageId: 'k1', task: '' },
    { id: 't2', title: 'Макеты доски, списка и диаграммы Ганта', agent: 'gemini', domain: 'design', tier: 'standard', scope: 'design/', dependsOn: [], status: 'running', messageId: 'k2', task: '' },
    { id: 't3', title: 'Nuxt: список задач и канбан поверх API', agent: 'claude', domain: 'frontend', tier: 'standard', scope: 'frontend/', dependsOn: ['t1', 't2'], status: 'pending', task: '' },
    { id: 't4', title: 'Docker Compose и CI в GitLab', agent: 'codex', domain: 'code', tier: 'standard', scope: 'deploy/, .gitlab-ci.yml', dependsOn: ['t1'], status: 'running', messageId: 'k3', task: '' },
  ];
  const teamMessages = [
    { id: 'tu', role: 'user', status: 'done', createdAt: at(0), parts: [text('Можете начинать, роли распределите сами')] },
    {
      id: 'tp', role: 'agent', agent: 'claude', kind: 'plan', replyTo: 'tu', status: 'done', createdAt: at(0.1), endedAt: at(1.2), plan,
      route: { agent: 'claude', model: 'sonnet', effort: 'medium', tier: 'hard', domain: 'planning', autonomy: 'readonly', via: 'llm', reason: 'командная задача: каркас трекера — бэкенд, фронтенд и дизайн' },
      usage: { input: 41200, output: 1830 },
      parts: [tool('p1', 'Read', 'docs/PLAN.md'), text('Делим по зонам: **Codex** — Go API и инфраструктура, **Gemini** — макеты, я — фронтенд на Nuxt, когда будут API и макеты. В конце проверю стыковку и отчитаюсь.')],
    },
    {
      id: 'k1', role: 'agent', agent: 'codex', kind: 'task', replyTo: 'tp', taskId: 't1', subtitle: '1/4 · API задач и проектов на Go', status: 'done', createdAt: at(1.3), endedAt: at(9),
      route: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'high', tier: 'hard', domain: 'code', autonomy: 'auto', via: 'system', reason: 'задача 1/4 из плана Claude' },
      usage: { input: 182000, output: 9400 },
      parts: [tool('x1', 'Edit', 'backend/internal/tasks/handler.go'), tool('x2', 'Edit', 'backend/internal/tasks/store.go'), tool('x3', 'Shell', 'go test ./...'), text('Готово: CRUD задач и проектов, `go test ./...` зелёный. Изменены файлы в `backend/internal/tasks/`.')],
    },
    {
      id: 'k2', role: 'agent', agent: 'gemini', kind: 'task', replyTo: 'tp', taskId: 't2', subtitle: '2/4 · Макеты доски, списка и диаграммы Ганта', status: 'streaming', createdAt: at(1.3),
      route: { agent: 'gemini', model: 'gemini-4-argon-low', effort: 'low', tier: 'standard', domain: 'design', autonomy: 'auto', via: 'system', reason: 'задача 2/4 из плана Claude' },
      parts: [tool('g1', 'write_to_file', 'design/board.svg'), tool('g2', 'write_to_file', 'design/gantt.svg', 'running')],
    },
    {
      id: 'k3', role: 'agent', agent: 'codex', kind: 'task', replyTo: 'tp', taskId: 't4', subtitle: '4/4 · Docker Compose и CI в GitLab', status: 'streaming', createdAt: at(9.1),
      route: { agent: 'codex', model: 'gpt-6.1-sol', effort: 'medium', tier: 'standard', domain: 'code', autonomy: 'auto', via: 'system', reason: 'задача 4/4 из плана Claude' },
      parts: [tool('y1', 'Edit', 'deploy/docker-compose.yml', 'running')],
    },
  ];
  // The previous iteration's check, with the verdict and the plan the team is executing now.
  teamMessages.splice(1, 0, {
    id: 'tr', role: 'agent', agent: 'claude', kind: 'report', replyTo: 'tp0', goal: 'tu', iteration: 1, status: 'done', createdAt: at(0.05), endedAt: at(0.09),
    route: { agent: 'claude', model: 'sonnet', effort: 'medium', tier: 'standard', domain: 'planning', autonomy: 'auto', via: 'system', reason: 'лид: проверка итерации 1' },
    teamStatus: { status: 'continue', reason: 'каркас готов, нет API задач и экранов' },
    parts: [text('Каркас собран, `docker compose up` поднимает сервисы. Дальше — API задач, макеты и экраны.')],
  });
  if (teamMode) messages.splice(0, messages.length, ...teamMessages);

  return {
    conversation: { id: 'c1', title: empty ? 'Новый чат' : 'Healthcheck и мониторинг', createdAt: t0, updatedAt: Date.now(), messages: empty ? [] : messages, sessions: {} },
    history: [
      { id: 'c1', title: 'Healthcheck и мониторинг', updatedAt: Date.now() - 60_000 },
      { id: 'c0', title: 'SEO-стратегия для лендинга', updatedAt: Date.now() - 26 * 3600_000 },
      { id: 'cx', title: 'Рефакторинг модуля оплаты', updatedAt: Date.now() - 4 * 86400_000 },
    ],
    agents: [
      { id: 'claude', label: 'Claude', installed: true, enabled: true, version: '2.1.302', busy: !empty, limits: { fiveHour: { usedPercent: 34, resetsAt: reset5h }, weekly: { usedPercent: 12, resetsAt: resetWeek }, updatedAt: Date.now() } },
      // Codex on Pro has no 5-hour window.
      { id: 'codex', label: 'Codex', installed: true, enabled: true, version: '0.163.0', busy: false, limits: { fiveHour: null, weekly: { usedPercent: 74, resetsAt: resetWeek }, updatedAt: Date.now() } },
      { id: 'gemini', label: 'Gemini', installed: true, enabled: true, version: '1.4.2', busy: false, limits: { fiveHour: { usedPercent: 91, resetsAt: reset5h }, weekly: { usedPercent: 6, resetsAt: resetWeek }, updatedAt: Date.now() - 4 * 60_000 } },
    ],
    running: !empty,
    queue: empty ? [] : ['Потом обнови README: раздел про мониторинг'],
    prefs: { mode: teamMode ? 'team' : 'auto', profile: 'balanced', autonomy: 'auto', autopilot: true },
    workspace: 'my-service',
    trusted: !new URLSearchParams(location.search).has('untrusted'),
    // The sample chat is in Russian; ?lang=en switches the UI around it.
    locale: new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'ru',
  };
}
