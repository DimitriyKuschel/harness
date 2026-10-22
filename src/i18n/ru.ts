import type { Strings } from './en';

export const ru: Strings = {
  dateLocale: 'ru-RU',
  newChat: 'Новый чат',

  time: {
    seconds: (s) => `${s} с`,
    minutes: (m, s) => (s ? `${m} мин ${s} с` : `${m} мин`),
    justNow: 'только что',
    minutesAgo: (m) => `${m} мин назад`,
    yesterday: 'вчера',
  },

  limits: {
    notYet: 'Лимиты ещё не получены',
    fiveHours: '5 часов',
    week: 'Неделя',
    noWindow: (name) => `${name}: у тарифа нет такого лимита`,
    noData: (name) => `${name}: нет данных`,
    left: (name, pct) => `${name}: осталось ${pct}%`,
    updated: (when) => `Обновлено: ${when}`,
    resetsAt: (time) => `сброс в ${time}`,
    resetsOn: (date, time) => `сброс ${date}, ${time}`,
    meterFiveHours: '5 ч',
    meterWeek: 'нед',
    meterNone: 'Такого лимита у тарифа нет',
    meterLeft: (pct) => `Осталось ${pct}%`,
    meterNoData: 'Нет данных',
  },

  agents: {
    taglines: {
      claude: 'архитектура, UI, тексты, планирование',
      codex: 'реализация кода, бэкенд, тесты, ревью',
      gemini: 'графика, мультимодальность, исследования',
    },
    notInstalled: 'не установлен',
    disabled: 'выключен',
    working: 'работает…',
    ready: 'готов',
    clickToRefresh: 'Нажмите, чтобы обновить',
    disabledInSettings: 'выключен в настройках',
    installAgy: 'установите Antigravity CLI (agy)',
    cliNotFound: 'CLI не найден',
  },

  header: {
    history: 'История чатов',
    settings: 'Настройки роутинга и моделей',
    historyEmpty: 'Здесь появятся прошлые обсуждения',
    delete: 'Удалить',
  },

  empty: {
    title: (ready) => `Ваша AI-команда ${ready ? 'на месте' : 'ещё не собрана'}`,
    lead: 'Опишите задачу — роутер сам выберет исполнителя, модель и effort, чтобы не тратить лимиты зря.',
    project: 'Работаем в проекте',
    recheck: 'Проверить агентов ещё раз',
    brainstormTag: 'брейншторм',
    suggestions: {
      architecture: 'Как улучшить архитектуру этого проекта? Какие главные риски?',
      tests: '@codex запусти тесты и почини то, что падает',
      roadmap: 'Составь план развития проекта на месяц с приоритетами',
      marketing: 'Предложите SEO- и маркетинговую стратегию для запуска',
    },
    tips: { send: 'отправить', newline: 'новая строка', mention: 'позвать агента', stop: 'остановить' },
  },

  trust: {
    title: (workspace) => `Папка ${workspace ? `«${workspace}» ` : ''}открыта в ограниченном режиме`,
    body: 'Агенты запускают команды и правят файлы, поэтому VS Code разрешает им работать только в доверенных папках.',
    button: 'Доверять папке',
  },

  scrollDown: 'К последнему сообщению',
  copy: 'Копировать',
  openFile: 'Открыть файл',

  composer: {
    modes: {
      auto: { label: 'Авто', title: 'Роутер выбирает исполнителя, модель и effort. Крупную работу сам отдаёт всей команде' },
      team: { label: 'Команда', title: 'Лид составляет план и раздаёт задачи агентам по сильным сторонам, затем проверяет результат' },
      brainstorm: { label: 'Брейншторм', title: 'Все агенты отвечают независимо, модератор сводит мнения' },
    },
    profiles: {
      eco: { label: 'Эко', title: 'На уровень проще: экономия лимитов' },
      balanced: { label: 'Баланс', title: 'Как оценил роутер' },
      max: { label: 'Макс', title: 'На уровень сильнее: качество важнее лимитов' },
    },
    autonomy: {
      readonly: { label: 'Только чтение', title: 'Агенты читают проект, но ничего не меняют' },
      auto: { label: 'Правки', title: 'Агенты правят файлы в проекте; опасные команды — по их авто-проверке' },
      full: { label: 'Полный доступ', title: 'Без песочницы и подтверждений. Только для доверенных задач' },
    },
    mentionAll: 'Все',
    mentionAllHint: 'брейншторм всей командой',
    unqueue: 'Убрать из очереди',
    placeholders: {
      auto: 'Задача для команды. @claude, @codex, @gemini — обратиться напрямую',
      team: 'Задача для всей команды — лид распределит работу…',
      brainstorm: 'Тема для брейншторма — ответят все агенты…',
    },
    stopAll: 'Остановить всех (Esc)',
    queue: 'Поставить в очередь (Enter)',
    send: 'Отправить (Enter)',
    mode: 'Режим',
    autopilot: 'Автопилот',
    autopilotOn:
      'Автопилот включён: команда работает итерациями «план → задачи → проверка», пока лид не признает цель достигнутой или ему не понадобится ваше решение',
    autopilotOff: 'Автопилот выключен: после проверки лид ждёт вашего решения',
    profile: 'Расход лимитов',
    access: 'Что агентам можно делать в проекте',
  },

  message: {
    kinds: {
      brainstorm: 'Брейншторм',
      debate: 'Раунд обсуждения',
      synthesis: 'Сводка модератора',
      review: 'Ревью',
      fix: 'Исправления по ревью',
      plan: 'План команды',
      task: 'Задача',
      report: 'Проверка лида',
    },
    teamStatus: {
      done: 'Цель достигнута',
      continue: 'Нужна ещё итерация',
      blocked: 'Нужно решение CEO',
    },
    taskStatus: {
      pending: 'ждёт очереди',
      running: 'в работе',
      done: 'готово',
      error: 'ошибка',
      stopped: 'остановлена',
      skipped: 'пропущена: не выполнена зависимость',
    },
    tiers: { trivial: 'простая', standard: 'обычная', hard: 'сложная', critical: 'критичная' },
    domains: {
      code: 'код',
      frontend: 'фронтенд',
      design: 'дизайн',
      research: 'исследование',
      writing: 'тексты',
      marketing: 'маркетинг',
      planning: 'планирование',
      data: 'данные',
      other: 'общее',
    },
    autonomy: { readonly: 'только чтение', auto: 'правки', full: 'полный доступ' },
    router: 'Роутер',
    routing: 'Подбираю исполнителя, модель и effort…',
    assigning: 'Распределяю задачи',
    summing: 'Подвожу итог',
    nextIteration: (n) => `Следующая итерация (${n})`,
    collapse: 'Свернуть',
    expand: 'Показать полностью',
    thinking: 'Думает',
    error: 'Ошибка',
    stopped: 'Остановлено',
    route: {
      defaultModel: 'по умолчанию',
      model: 'Модель',
      effort: 'Effort',
      tier: 'Сложность',
      domain: 'область',
      access: 'Доступ',
      reason: 'Причина',
    },
    tierTask: (tier) => `${tier} задача`,
    tools: (n) => `${n} ${plural(n, 'действие', 'действия', 'действий')}`,
    toolsFailed: (n) => `${n} с ошибкой`,
    teamTasks: 'Задачи команды',
    after: (tasks) => `после ${tasks}`,
    goToTask: 'Перейти к выполнению',
    actions: {
      retry: { label: 'Повторить', title: 'Запустить ещё раз тем же агентом' },
      fix: { label: 'Исправить', title: 'Передать замечания автору' },
      continue: { label: 'Ещё итерация', title: 'Лид составит план следующей итерации, команда его выполнит' },
      continueReady: 'Запустить следующую итерацию по плану лида',
      debate: { label: 'Ещё раунд', title: 'Каждый участник критикует ответы коллег, затем новая сводка' },
      review: { label: 'Ревью', title: 'Проверка агентом другого вендора' },
      stronger: { label: 'Сильнее', title: 'Переделать этим же агентом на уровень сложнее (сильнее модель / больше effort)' },
    },
    tokens: 'Токены: вход (вместе с кэшем) / выход',
    copyAnswer: 'Копировать ответ',
  },

  host: {
    chatNotFound: 'Чат не найден.',
    fileNotFound: (file) => `Файл не найден: ${file}`,
    statusBusy: 'Команда работает — открыть чат',
    statusIdle: 'Открыть чат команды',
  },

  notices: {
    noAgents: 'Нет доступных агентов. Проверьте, что CLI установлены и включены в настройках Harness.',
    routerNoAgents: 'Нет доступных агентов: проверьте установку CLI и настройки Harness.',
    unavailable: (agents) => `Недоступны: ${agents} — пропускаю.`,
    reviewNeedsSecond: 'Для ревью нужен второй доступный агент.',
    planUnparsed: (isPlan) =>
      `Не удалось разобрать план лида — задачи не розданы. ${isPlan ? 'Нажмите «Повторить» под планом.' : 'Нажмите «Ещё итерация».'}`,
    noTaskDone: 'Ни одна задача итерации не выполнена — команда остановилась. Причины — в сообщениях выше.',
    autopilotStopped: (why) => `Автопилот остановлен: ${why}`,
    stopIterations: (max) => `достигнут лимит итераций (${max}). Нажмите «Ещё итерация», чтобы продолжить.`,
    stopQueued: 'у CEO новое сообщение — сначала оно.',
    stopQuota: 'лимиты подписок почти исчерпаны.',
    stopNoPlan: 'лид не дал план следующей итерации. Нажмите «Ещё итерация».',
    handoffLimit: (max, waiting) =>
      `Агенты передали ход друг другу ${max} раз подряд — дальше решает CEO. Ждут ответа: ${waiting}. Упомяните агента, чтобы продолжить.`,
    handoffDeferred: (waiting) => `Передача хода отложена: у CEO новое сообщение. Ждут ответа: ${waiting}.`,
    calledBy: (agent, from) => `${agent} (зовёт ${from})`,
    busy: ' (занят)',
    noHandoff: (agents) => `Не передаю ход: ${agents} — недоступны сейчас.`,
  },

  reasons: {
    review: (author) => `ревью ответа ${author}`,
    fix: (reviewer) => `исправления по ревью ${reviewer}`,
    stronger: 'CEO попросил сильнее',
    retry: 'повтор после ошибки',
    debate: 'раунд обсуждения',
    brainstorm: 'брейншторм',
    synthesis: 'модератор: сводка мнений',
    teamTask: (reason) => `командная задача: ${reason}`,
    leadPlan: 'лид: план и распределение задач',
    leadIterationPlan: (n) => `лид: план итерации ${n}`,
    leadCheck: (n) => `лид: проверка итерации ${n}`,
    planTask: (n, total, lead) => `задача ${n}/${total} из плана ${lead}`,
    askedBy: (who) => `по просьбе ${who}`,
    manual: 'выбрано вручную',
    continued: 'продолжение работы агента',
    mention: 'по упоминанию',
    heuristic: 'эвристика по тексту',
  },

  iteration: (n) => `итерация ${n}`,
  taskTitle: (n) => `Задача ${n}`,

  cli: {
    notFound: (bin) => `«${bin}» не найден`,
    agyNotInstalled: 'Antigravity CLI (agy) не установлен',
    stopped: 'остановлено',
    exited: (cli, code) => `${cli} завершился с кодом ${code}`,
    missingCwd: (dir) => `рабочая папка не найдена: ${dir}`,
    turnFailed: 'ход завершился ошибкой',
    codexError: 'ошибка codex',
    denied: (actions) => `Нет разрешения на: ${actions} — попробуйте режим «Правки»`,
    emptyReply: 'пустой ответ',
    items: (n) => `${n} пунктов`,
    inPath: (pattern, path) => `${pattern} в ${path}`,
  },
};

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
