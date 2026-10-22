import type { AgentId, Autonomy, Domain, MessageKind, Mode, Profile, TaskStatus, TeamStatus, Tier } from '../core/types';

type Labeled = { label: string; title: string };

/** UI strings, shared by the extension host and the webview. `ru.ts` mirrors this shape. */
export const en = {
  /** For `toLocaleTimeString` / `toLocaleDateString`. */
  dateLocale: 'en-US',
  newChat: 'New chat',

  time: {
    seconds: (s: number) => `${s}s`,
    minutes: (m: number, s: number) => (s ? `${m}m ${s}s` : `${m}m`),
    justNow: 'just now',
    minutesAgo: (m: number) => `${m} min ago`,
    yesterday: 'yesterday',
  },

  limits: {
    notYet: 'Limits not received yet',
    fiveHours: '5 hours',
    week: 'Week',
    noWindow: (name: string) => `${name}: the plan has no such limit`,
    noData: (name: string) => `${name}: no data`,
    left: (name: string, pct: number) => `${name}: ${pct}% left`,
    updated: (when: string) => `Updated: ${when}`,
    resetsAt: (time: string) => `resets at ${time}`,
    resetsOn: (date: string, time: string) => `resets ${date}, ${time}`,
    meterFiveHours: '5h',
    meterWeek: 'wk',
    meterNone: 'The plan has no such limit',
    meterLeft: (pct: number) => `${pct}% left`,
    meterNoData: 'No data',
  },

  agents: {
    taglines: {
      claude: 'architecture, UI, writing, planning',
      codex: 'code, backend, tests, review',
      gemini: 'graphics, multimodal, research',
    } as Record<AgentId, string>,
    notInstalled: 'not installed',
    disabled: 'disabled',
    working: 'working…',
    ready: 'ready',
    clickToRefresh: 'Click to refresh',
    disabledInSettings: 'disabled in settings',
    installAgy: 'install Antigravity CLI (agy)',
    cliNotFound: 'CLI not found',
  },

  header: {
    history: 'Chat history',
    settings: 'Routing and model settings',
    historyEmpty: 'Past discussions will appear here',
    delete: 'Delete',
  },

  empty: {
    title: (ready: boolean): string => (ready ? 'Your AI team is here' : 'Your AI team is not assembled yet'),
    lead: 'Describe a task: the router picks the assignee, model and effort so limits aren’t wasted.',
    project: 'Working in',
    recheck: 'Check agents again',
    brainstormTag: 'brainstorm',
    suggestions: {
      architecture: 'How can the architecture of this project be improved? What are the main risks?',
      tests: '@codex run the tests and fix what fails',
      roadmap: 'Draft a one-month roadmap for the project with priorities',
      marketing: 'Suggest an SEO and marketing strategy for the launch',
    },
    tips: { send: 'send', newline: 'new line', mention: 'call an agent', stop: 'stop' },
  },

  trust: {
    title: (workspace?: string) => (workspace ? `The folder “${workspace}” is open in Restricted Mode` : 'The folder is open in Restricted Mode'),
    body: 'Agents run commands and edit files, so VS Code only lets them work in trusted folders.',
    button: 'Trust folder',
  },

  scrollDown: 'Go to the latest message',
  copy: 'Copy',
  openFile: 'Open file',

  composer: {
    modes: {
      auto: { label: 'Auto', title: 'The router picks the assignee, model and effort, and hands big work to the whole team' },
      team: { label: 'Team', title: 'The lead makes a plan, assigns tasks to agents by their strengths, then checks the result' },
      brainstorm: { label: 'Brainstorm', title: 'Every agent answers independently, a moderator sums up the views' },
    } as Record<Mode, Labeled>,
    profiles: {
      eco: { label: 'Eco', title: 'One level lighter: saves limits' },
      balanced: { label: 'Balanced', title: 'As the router assessed it' },
      max: { label: 'Max', title: 'One level stronger: quality over limits' },
    } as Record<Profile, Labeled>,
    autonomy: {
      readonly: { label: 'Read only', title: 'Agents read the project but change nothing' },
      auto: { label: 'Edits', title: 'Agents edit files in the project; risky commands go through their auto-check' },
      full: { label: 'Full access', title: 'No sandbox and no confirmations. Only for trusted tasks' },
    } as Record<Autonomy, Labeled>,
    mentionAll: 'All',
    mentionAllHint: 'brainstorm with the whole team',
    unqueue: 'Remove from the queue',
    placeholders: {
      auto: 'A task for the team. @claude, @codex, @gemini to address one directly',
      team: 'A task for the whole team: the lead will split the work…',
      brainstorm: 'A topic to brainstorm: every agent will answer…',
    } as Record<Mode, string>,
    stopAll: 'Stop everyone (Esc)',
    queue: 'Add to the queue (Enter)',
    send: 'Send (Enter)',
    mode: 'Mode',
    autopilot: 'Autopilot',
    autopilotOn:
      'Autopilot on: the team works in “plan → tasks → check” iterations until the lead considers the goal reached or needs your decision',
    autopilotOff: 'Autopilot off: after the check the lead waits for your decision',
    profile: 'Limit usage',
    access: 'What agents may do in the project',
  },

  message: {
    kinds: {
      brainstorm: 'Brainstorm',
      debate: 'Discussion round',
      synthesis: 'Moderator summary',
      review: 'Review',
      fix: 'Review fixes',
      plan: 'Team plan',
      task: 'Task',
      report: 'Lead’s check',
    } as Partial<Record<MessageKind, string>>,
    teamStatus: {
      done: 'Goal reached',
      continue: 'Another iteration needed',
      blocked: 'CEO decision needed',
    } as Record<TeamStatus['status'], string>,
    taskStatus: {
      pending: 'waiting',
      running: 'in progress',
      done: 'done',
      error: 'error',
      stopped: 'stopped',
      skipped: 'skipped: a dependency failed',
    } as Record<TaskStatus, string>,
    tiers: { trivial: 'simple', standard: 'standard', hard: 'hard', critical: 'critical' } as Record<Tier, string>,
    domains: {
      code: 'code',
      frontend: 'frontend',
      design: 'design',
      research: 'research',
      writing: 'writing',
      marketing: 'marketing',
      planning: 'planning',
      data: 'data',
      other: 'general',
    } as Record<Domain, string>,
    autonomy: { readonly: 'read only', auto: 'edits', full: 'full access' } as Record<Autonomy, string>,
    router: 'Router',
    routing: 'Picking the assignee, model and effort…',
    assigning: 'Assigning tasks',
    summing: 'Wrapping up',
    nextIteration: (n: number) => `Next iteration (${n})`,
    collapse: 'Collapse',
    expand: 'Show all',
    thinking: 'Thinking',
    error: 'Error',
    stopped: 'Stopped',
    route: {
      defaultModel: 'default',
      model: 'Model',
      effort: 'Effort',
      tier: 'Complexity',
      domain: 'area',
      access: 'Access',
      reason: 'Reason',
    },
    tierTask: (tier: string) => `${tier} task`,
    tools: (n: number) => `${n} ${n === 1 ? 'action' : 'actions'}`,
    toolsFailed: (n: number) => `${n} failed`,
    teamTasks: 'Team tasks',
    after: (tasks: string) => `after ${tasks}`,
    goToTask: 'Go to the run',
    actions: {
      retry: { label: 'Retry', title: 'Run again with the same agent' },
      fix: { label: 'Fix', title: 'Send the remarks to the author' },
      continue: { label: 'Another iteration', title: 'The lead plans the next iteration, the team carries it out' },
      continueReady: 'Run the next iteration from the lead’s plan',
      debate: { label: 'Another round', title: 'Each participant critiques the colleagues’ answers, then a new summary' },
      review: { label: 'Review', title: 'A check by an agent from another vendor' },
      stronger: { label: 'Stronger', title: 'Redo with the same agent one level up (stronger model / more effort)' },
    },
    tokens: 'Tokens: input (with cache) / output',
    copyAnswer: 'Copy the answer',
  },

  host: {
    chatNotFound: 'Chat not found.',
    fileNotFound: (file: string) => `File not found: ${file}`,
    statusBusy: 'The team is working: open the chat',
    statusIdle: 'Open the team chat',
  },

  notices: {
    noAgents: 'No agents available. Check that the CLIs are installed and enabled in the Harness settings.',
    routerNoAgents: 'No agents available: check the CLI installation and the Harness settings.',
    unavailable: (agents: string) => `Unavailable: ${agents}, skipping.`,
    reviewNeedsSecond: 'A review needs a second available agent.',
    planUnparsed: (isPlan: boolean) =>
      `Couldn’t parse the lead’s plan, no tasks were assigned. ${isPlan ? 'Click “Retry” under the plan.' : 'Click “Another iteration”.'}`,
    noTaskDone: 'No task of the iteration succeeded, so the team stopped. The reasons are in the messages above.',
    autopilotStopped: (why: string) => `Autopilot stopped: ${why}`,
    stopIterations: (max: number) => `the iteration limit (${max}) is reached. Click “Another iteration” to continue.`,
    stopQueued: 'the CEO has a new message, it goes first.',
    stopQuota: 'subscription limits are nearly used up.',
    stopNoPlan: 'the lead didn’t plan the next iteration. Click “Another iteration”.',
    handoffLimit: (max: number, waiting: string) =>
      `Agents handed the turn to each other ${max} times in a row, so the CEO decides next. Waiting for an answer: ${waiting}. Mention an agent to continue.`,
    handoffDeferred: (waiting: string) => `Handoff postponed: the CEO has a new message. Waiting for an answer: ${waiting}.`,
    calledBy: (agent: string, from: string) => `${agent} (called by ${from})`,
    busy: ' (busy)',
    noHandoff: (agents: string) => `Not handing the turn over: ${agents} unavailable right now.`,
  },

  /** Why a run went to this agent and level: shown under the reply and in the model chip. */
  reasons: {
    review: (author: string) => `review of ${author}’s answer`,
    fix: (reviewer: string) => `fixes after ${reviewer}’s review`,
    stronger: 'the CEO asked for a stronger run',
    retry: 'retry after an error',
    debate: 'discussion round',
    brainstorm: 'brainstorm',
    synthesis: 'moderator: summary of the views',
    teamTask: (reason: string) => `team task: ${reason}`,
    leadPlan: 'lead: plan and task assignment',
    leadIterationPlan: (n: number) => `lead: plan for iteration ${n}`,
    leadCheck: (n: number) => `lead: check of iteration ${n}`,
    planTask: (n: number, total: number, lead: string) => `task ${n}/${total} from ${lead}’s plan`,
    askedBy: (who: string) => `asked by ${who}`,
    manual: 'chosen manually',
    continued: 'continuing the agent’s work',
    mention: 'by mention',
    heuristic: 'text heuristics',
  },

  iteration: (n: number) => `iteration ${n}`,
  taskTitle: (n: number) => `Task ${n}`,

  cli: {
    notFound: (bin: string) => `“${bin}” not found`,
    agyNotInstalled: 'Antigravity CLI (agy) is not installed',
    stopped: 'stopped',
    exited: (cli: string, code: number | null) => `${cli} exited with code ${code}`,
    // Not "not found": the orchestrator reads that as a stale session.
    missingCwd: (dir: string) => `the working folder is missing: ${dir}`,
    turnFailed: 'the turn failed',
    codexError: 'codex error',
    denied: (actions: string) => `No permission for: ${actions}. Try the “Edits” mode`,
    emptyReply: 'empty reply',
    items: (n: number) => `${n} items`,
    inPath: (pattern: string, path: string) => `${pattern} in ${path}`,
  },
};

export type Strings = typeof en;
