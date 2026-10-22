# Harness — AI Team

[Русская версия](README.ru.md)

A VS Code extension: a team chat where Claude Code, Codex and Antigravity (Gemini) work on your project as one team, and you are the CEO.

It works **through the official CLIs on your own subscriptions**: the extension runs `claude -p`, `codex exec` and `agy -p` as child processes. No tokens are extracted and no API keys are needed.

## Features

- **Routing.** Without an @mention, a cheap model (Haiku / Luna / Flash at low effort) assesses the task: complexity (`trivial → critical`), area (code, frontend, design, marketing…) and whether the whole team is needed. The assignee is picked by rules, not by the classifier: the agent order for the area (`harness.routing.affinity`) and the quota already spent. Every 60% of spent quota outweighs one step of preference, so the work spreads across all your subscriptions. The router skips an agent that has almost run out of quota.
- **Team.** In Team mode (or in Auto, when the classifier decides the work is large or the CEO asks to split the roles), the lead makes a plan of 2–6 tasks and assigns them by strengths. Tasks of different agents run in parallel, tasks of one agent run in turn, dependencies first. At the end the lead checks the result against the done criteria and gives a verdict: the goal is reached, another iteration is needed, or the CEO has to decide. The task card shows the plan's progress.
- **Autopilot** (a toggle next to the mode, on by default). If the lead decides another iteration is needed, it plans it right away and the team continues without the CEO until the goal is reached. Autopilot stops when the lead needs the CEO's decision, when the iteration limit is reached (`harness.team.maxIterations`, 5 by default), when no task of an iteration succeeded, when all agents are nearly out of quota, or when the CEO sends a new message. The "Another iteration" button under the lead's check continues the work manually.
- **@mentions.** `@claude`, `@codex` and `@gemini` address an agent directly. With several mentions, the agents reply in parallel. `@all` starts a brainstorm. Russian aliases work too (`@клод`, `@кодекс`, `@джемини`, `@все`).
- **Brainstorm.** Every agent answers independently, then a moderator sums up the consensus, the disagreements, a recommendation and questions for the CEO. "Another round": everyone critiques the colleagues' answers, then a new summary.
- **Cross-review.** "Review" hands an answer to an agent from a *different* vendor for a read-only check. "Fix" sends the remarks back to the author.
- **"Stronger".** Reruns the task with the same agent one level up: a stronger model and more reasoning.
- **Shared context.** Each agent keeps its own native session. Before each turn, an agent gets only the chat messages it hasn't seen yet.
- **Subscription limits.** The agent cards in the header show how much is **left** in the 5-hour and weekly windows; the tooltip shows when they reset. The data comes from the CLIs themselves, without a model call: `claude -p /usage`, `codex app-server` (`account/rateLimits/read`), `agy -p /usage` (the Gemini model group). It refreshes on startup, every 5 minutes, after an agent run and when you click a card. The Codex Pro plan has no 5-hour window, so the card shows "∞".
- **Spend profile:** Eco / Balanced / Max shifts the model level down or up.
- **Access:** Read only / Edits / Full access (see the table below).
- **Queue.** Messages sent while the team is working run in order.
- **Languages.** English and Russian: the interface and the agents' instructions follow the `harness.language` setting.
- File references like `src/app.ts:42` in replies are clickable. Chat history is kept per workspace.

## Installation

```bash
npm install
npm run package          # → harness.vsix
code --install-extension harness.vsix
```

You need the `claude`, `codex` and `agy` (Antigravity CLI) CLIs installed and signed in. The extension looks for them on `PATH` and in `~/.local/bin`; you can set the paths in the `harness.agents.*.path` settings.

Development: `npm run watch` and F5 (Extension Development Host). UI preview without VS Code: run `python3 -m http.server` in the project root and open `preview/index.html` (`?theme=light`, `?empty=1`, `?team=1`, `?untrusted=1`, `?lang=en`).

## Access modes

| | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Read only | `dontAsk` + allowlist (Read/Grep/Glob, git status/diff/log, ls, find…) | `sandbox_mode=read-only` + `approval_policy=never` | `--mode plan` (no shell) |
| Edits | `--permission-mode auto` | `workspace-write` + network | `--dangerously-skip-permissions --sandbox` |
| Full access | `bypassPermissions` | `danger-full-access` | `--dangerously-skip-permissions` |

In read-only mode, Codex's requests to leave the sandbox are disabled. Otherwise, with `approvals_reviewer = "auto_review"` in `~/.codex/config.toml`, such a request is approved automatically and the command writes files.

Brainstorms, discussion rounds, reviews and planning always run read-only. Plan tasks run with the selected access level.

In VS Code's Restricted Mode the chat opens, but agents don't run until the folder is trusted.

## Settings

- `harness.language`: the language of the interface and of the agents' instructions: `auto` (follows VS Code: Russian for Russian, English otherwise), `en` or `ru`.
- `harness.models`: the model and effort for each complexity level of each agent.
- `harness.routing.affinity`: the agent preference order per area.
- `harness.team.maxIterations`: how many iterations autopilot may run without the CEO.
- `harness.routing.classifier`: `llm` (more accurate, one cheap call per message) or `heuristic` (no call).
- `harness.strengths`: what each agent is good at; the classifier and the lead see it when assigning tasks. Agents not listed here get a built-in description in the interface language.

## Known limitations

- Claude's remaining quota is read from the text of `/usage` (the command has no structured output). If the text format changes, the data from the stream (`rate_limit_event`) is still used.
- The UI has no action confirmations: the access mode is set in advance.
- Parallel team tasks share one working tree. The lead splits them into non-overlapping scopes (folders), but there is no strict isolation. Running tasks in git worktrees is planned.

## Structure

```
src/core/          no VS Code dependencies
  agents/          CLI adapters → a common event stream
  prompts/         agent instructions (en, ru)
  router.ts        task assessment, choice of agent/model/effort, quota accounting
  orchestrator.ts  chat, context, brainstorm, teamwork, review, fixes
  plan.ts          parsing the lead's plan (the team-plan block)
src/i18n/          UI strings (en, ru), shared by the host and the webview
src/host/          extension controller, chat storage, webview
src/webview/       React chat UI
src/test/          unit tests (npm test) and manual smoke scripts against the real CLIs
```
