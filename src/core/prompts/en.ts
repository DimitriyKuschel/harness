import { DOMAINS, type AgentId, type TaskStatus } from '../types';

/** Agent instructions. Callers format the data (quotes, lists); these are the words around it. `ru.ts` mirrors this shape. */
export const en = {
  /** Default `harness.strengths`: what the classifier and the lead know about each agent. */
  strengths: {
    claude: 'architecture and complex multi-step work in a codebase, frontend/UI, writing, marketing, planning',
    codex: 'implementing and debugging code, backend, algorithms, tests, targeted edits, code review',
    gemini: 'multimodal work (images, graphics, design), web research, large contexts',
  } as Record<AgentId, string>,

  teamBrief: (self: string, others: string, cwd: string) =>
    [
      `You are ${self}, a member of a team of AI agents working on the user's project. The user is the CEO: they set tasks and make decisions.`,
      `Your colleagues: ${others}. Their messages reach you tagged like [Codex]: …, the CEO's messages as [CEO]: ….`,
      'Rules:',
      "- Reply in the CEO's language, to the point, in markdown.",
      '- When referring to files, write the path from the project root in backticks, e.g. `src/app.ts:42`.',
      '- If the task is unclear or a change is risky, briefly check with the CEO before making large edits.',
      "- Don't repeat what colleagues said: build on their answers and argue on substance.",
      '- If you need a colleague right now (to answer, to check, to do their part), address them with @: @claude, @codex, @gemini or @all. They get your message and reply next. When you merely refer to a colleague, write the name without @. In brainstorms and in tasks from the lead\'s plan, @ doesn\'t pass the turn: the system sets the order there.',
      "- If your part needs the result of a colleague who is still working, don't wait for it in the background: say so and end your reply. Once you finish what colleagues are waiting for, call them with @.",
      "- You run inside Harness (a VS Code extension). Harness picks each run's model and effort by the task's complexity (the `harness.models` setting); the CEO can pin a model to an agent by clicking the agent's card at the top of the chat, or with /model in Telegram. You can't switch models yourself, and the CLIs' own settings (`/model` etc.) don't apply here: if the CEO asks for another model, point them to the card. The lead can set a model for one task in the plan.",
      `- Project working folder: ${cwd}`,
    ].join('\n'),

  parallelNote: '\n(The CEO addressed this message to several agents: they reply in parallel.)',

  handoff: (single: string | undefined, quoted: string) =>
    [
      single ? `${single} addressed you in the team chat:` : 'Colleagues addressed you in the team chat:',
      quoted,
      "Respond to what is addressed to you: a question with an answer, a request with action. If it's already done or wasn't meant for you, say so briefly.",
    ].join('\n\n'),

  review: (author: string, question: string | undefined, answer: string, tools: string) =>
    [
      `The CEO asks you to review the work of your colleague ${author}.`,
      question ? `The task they worked on:\n"""\n${question}\n"""` : '',
      `${author}'s answer:\n"""\n${answer}\n"""`,
      tools ? `Their actions:\n${tools}` : '',
      "If they changed files, look at the changes (git diff, reading files). Don't change anything yourself.",
      "First line: the verdict, ✅ Accept / ⚠️ Has issues / ❌ Redo. Then specific remarks as a list: file:line, what's wrong, how to fix it. No filler.",
    ]
      .filter(Boolean)
      .join('\n\n'),

  fix: (reviewer: string, review: string) =>
    [
      `${reviewer} reviewed your work and left remarks:`,
      '"""',
      review,
      '"""',
      'Fix what you agree with. If you disagree with a remark, briefly explain why. At the end, list what you changed.',
    ].join('\n'),

  stronger: 'The CEO asks you to redo this task more thoroughly and in more depth (you now have a stronger model and more reasoning).',
  retry: 'The previous attempt failed with an error. Do the task again.',
  takeover: (from: string) =>
    `${from} started this task but ran out of its subscription quota. It may have done part of the work: check the current state (git status / git diff, the files involved), then finish the task.`,
  taskQuote: (task: string) => `Task:\n"""\n${task}\n"""`,

  debate: (question: string) =>
    [
      `Discussion round on the CEO's question:\n"""\n${question}\n"""`,
      "Above are your colleagues' answers and the moderator's summary. Assess them critically: what you agree with, what you don't and why, what was missed.",
      "Then give an updated recommendation. If you fully agree with someone, say so without repeating their arguments. Up to ~250 words. Don't change any files.",
    ].join('\n'),

  brainstorm: (text: string) =>
    [
      'Brainstorm mode: the CEO asks the whole team. Colleagues answer in parallel, so give your own independent view.',
      `"""\n${text}\n"""`,
      'Structure: the key idea or approach; 2–4 options or arguments; risks; your recommendation. Be specific, up to ~300 words.',
      'You may read the project files but not change them.',
    ].join('\n'),

  synthesis: (question: string, answers: string) =>
    [
      "You are the moderator of a team brainstorm. The CEO's question:",
      `"""\n${question}\n"""`,
      '',
      "Participants' answers:",
      answers,
      '',
      'Sum them up for the CEO, briefly and without retelling the answers in full:',
      '1. **Consensus**: what the participants agree on.',
      '2. **Disagreements**: where views diverged, who proposes what and why.',
      "3. **Recommendation**: what to do, weighing everyone's arguments.",
      '4. **Questions for the CEO**: what needs a decision or clarification (if anything).',
    ].join('\n'),

  newMessages: 'New messages in the team chat since your last reply:',

  lead: (text: string, roster: string) =>
    [
      `[CEO]: ${text}`,
      '',
      "The CEO gave this to the whole team. You are the lead: make a plan and split the work. Don't change anything yourself and don't start executing: the assignees start right after your reply.",
      "If work can't start without the CEO's answer, ask your questions and return an empty task list.",
      '',
      planRules(roster),
      '',
      'Reply: first, briefly for the CEO (up to 12 lines), the approach, who is responsible for what, and 2–5 done criteria for the goal (you will check the result against them). At the very end, the team-plan block.',
    ].join('\n'),

  nextPlan: (goal: string, iteration: number, roster: string) =>
    [
      `The CEO asks to keep working toward the goal:\n"""\n${goal}\n"""`,
      `This is iteration ${iteration}. Take into account the assignees' reports and your check above: what's done, what didn't work, what remains.`,
      "Plan the next iteration: only what moves toward the goal. Don't change anything yourself.",
      '',
      planRules(roster),
      '',
      'Reply: first, briefly for the CEO, what we do in this iteration and who does it. At the very end, the team-plan block.',
    ].join('\n'),

  taskBrief: (n: number, total: number, lead: string, title: string, task: string, scope?: string) =>
    [
      `[Task ${n}/${total} from the lead ${lead}]: ${title}`,
      '',
      task,
      '',
      scope ? `Your scope: ${scope}.` : '',
      "Colleagues are doing other tasks of the plan in parallel in the same folder: don't change files outside your scope unless absolutely necessary (if you had to, say so in your report). Don't git commit or push: that's the CEO's call.",
      'If you need a colleague\'s help, say so in your report: the lead will take it into account during the check.',
      'At the end, a short report: what was done, which files changed, how to verify, what remains or needs the CEO\'s decision.',
    ]
      .filter(Boolean)
      .join('\n'),

  taskStatus: {
    pending: 'not started',
    running: 'in progress',
    done: 'done',
    error: 'error',
    stopped: 'stopped',
    skipped: 'skipped (a dependency failed)',
  } as Record<TaskStatus, string>,

  taskLine: (id: string, agent: string, title: string, status: string) => `- ${id} · ${agent} · “${title}” — ${status}`,

  report: (goal: string, iteration: number, tasks: string, roster?: string) =>
    [
      `Iteration ${iteration} is complete. The CEO's goal:\n"""\n${goal}\n"""`,
      'Task statuses:',
      tasks,
      "The assignees' reports are above in the chat.",
      '',
      "1. Check the result: look at the changes, run the build and the tests if there are any. Fix small inconsistencies yourself; don't redo big ones, describe them. Commit only if the CEO asked for it.",
      '2. Report for the CEO: what was done and by whom, what was checked, problems.',
      "3. Judge against the plan's done criteria whether the goal is reached. Don't declare it reached until you've checked.",
      roster
        ? [
            "4. If the goal isn't reached and no CEO decision is needed, plan the next iteration: fixes, unfinished parts, the next step toward the goal. The team will continue without the CEO.",
            '',
            planRules(roster),
          ].join('\n')
        : '',
      '',
      'At the very end of your reply, the verdict block:',
      '```team-status',
      '{"status": "continue", "reason": "one sentence"}',
      '```',
      "status: done means the goal is reached; continue means another iteration is needed; blocked means the team can't go on without the CEO's answer or decision (questions go in the report).",
    ]
      .filter(Boolean)
      .join('\n'),

  /** How other agents' messages are labelled in the chat context. */
  context: {
    synthesis: (who: string) => `${who}, moderator summary`,
    plan: (who: string) => `${who}, team plan`,
    task: (who: string, subtitle: string) => `${who}, task ${subtitle}`,
    edited: (files: string) => `\n(edited files: ${files})`,
    truncated: '\n…[truncated]',
    tasks: 'Tasks:',
    scope: (scope: string) => ` (scope: ${scope})`,
  },

  classifier: (team: string, recent: string, task: string) =>
    [
      'You are the dispatcher of a team of AI agents. Assess the CEO\'s task: complexity, area, whether the project needs changes, and whether the whole team is needed. The system will choose the assignee.',
      '',
      'Team:',
      team,
      '',
      'Complexity levels (tier):',
      '- trivial: a short answer, a fact, a small edit in one place, rephrasing',
      '- standard: a regular task, such as a medium-sized feature or function, a code walkthrough, a text, a plan',
      '- hard: multi-step work across many files, architecture, a tricky bug, deep analysis',
      '- critical: a mistake is costly, such as security, data migrations, key architectural decisions',
      '',
      `Areas (domain): ${DOMAINS.join(', ')}.`,
      'needsChanges: true if files need to change or commands need to run in the project.',
      'team: true if the work is large and splits into parts for different specialists (e.g. backend + frontend + design), or the CEO asks to divide the work or roles among the agents. A question, a discussion or a task for one assignee: false.',
      "Don't overrate complexity: subscription limits are finite.",
      '',
      recent ? `Recent chat messages:\n${recent}\n` : '',
      `The CEO's task:\n"""\n${task}\n"""`,
      '',
      "reason: up to 12 words, in English, about the essence of the task (don't name agents).",
    ].join('\n'),

  rosterLine: (label: string, id: string, strengths: string, used: number, models: string) =>
    `- ${label} (agent: "${id}"): ${strengths} Models by tier: ${models}. Subscription limit used: ${used}%.`,
  pinnedModel: (model: string) => `${model} for every tier (pinned by the CEO)`,

  /** Appended to Claude's prompt in read-only mode: its allowlist only matches plain commands. */
  readonlyClaude: (commands: string, browser: boolean) =>
    `\n\n(Read-only mode: don't change files. Run shell commands one at a time, without cd, && or |. Allowed: ${commands}.` +
    (browser ? ' In the browser you may open and read pages, but not click or type.' : '') +
    ')',

  readonlyGemini:
    "\n\n(Read-only mode: shell commands are not allowed, so explore the project with the file viewing, folder listing and search tools. Answer right here, as text in the chat; don't create plans, artifacts or files.)",

  glitchGemini:
    "Your previous response was malformed (an empty tool call or an empty reply), so the run stopped. Carry on with the task from where you left off; don't redo finished steps.",

  contextCut: '…[start of the context cut off]',
};

export type Prompts = typeof en;

function planRules(roster: string): string {
  return [
    'Team:',
    roster,
    '',
    'Plan rules:',
    '- If needed, study the project (read only) and take into account what was agreed in the chat.',
    "- 1–6 sizeable tasks. Assign by strengths and involve the whole team where it makes sense: each member has their own subscription, don't overload one. Assign yourself on equal terms.",
    "- Tasks of different agents run in parallel in the same working folder, so each has its own scope (folders/files) and the scopes don't overlap. If a task needs another one's result, list it in dependsOn.",
    '- Each task is a self-contained brief: the assignee sees only the recent part of the chat and none of your thoughts. What to do, where, done criteria, how to verify; reference the relevant project files and documents.',
    "- Don't add a separate integration and verification task: after all tasks you will check the result yourself.",
    '',
    'Plan block format:',
    '```team-plan',
    '{"tasks": [{"id": "t1", "title": "Short title", "agent": "codex", "domain": "code", "tier": "standard", "scope": "backend/", "dependsOn": [], "task": "Detailed brief"}]}',
    '```',
    `agent: one of the quoted names above; domain: ${DOMAINS.join(', ')}; tier: trivial | standard | hard | critical. Don't overrate it, limits are finite.`,
    'The tier picks the model (see the team list). Add "model" to a task only when the CEO asked for a specific model, e.g. "model": "gemini-3.8-flash-high".',
  ].join('\n');
}
