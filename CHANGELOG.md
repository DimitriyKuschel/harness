# Changelog

## Unreleased

- **Telegram.** Connect a bot (**Harness: Connect Telegram**) to see the team's work on your phone and steer it: tasks, @mentions, replies to an agent, the message buttons (retry, review, fix, another iteration…), `/status`, `/stop`, `/mode`, `/model` and more. The chat is linked with a one-time code; the token lives in VS Code's secret storage.
- **Spent quota no longer stalls the team.** A run that fails with a quota error ("Individual quota reached… Resets in 163h…") marks the agent out of quota until the reset in the message, even when its CLI's `/usage` still shows quota left. Its plan tasks, routed answers, the lead's plan and check, reviews and summaries go to a colleague; brainstorms go on without it; "Retry" becomes "Hand over". Before, every retry went back to the same agent and failed again.
- **Pin a model to an agent** from its card in the header (or `/model` in Telegram). Agents now know models are chosen by Harness and point the CEO there instead of to the CLI's own settings; the lead can set a model for one plan task.
- **Gemini no longer fails on a malformed function call.** When the model sends an empty tool call ("Malformed function call: … Retries remaining: 3"), agy's own loop would retry, but `agy -p` ends the run there. Harness now resumes the same conversation and lets Gemini carry on, up to two times. Before, about one Gemini run in four in long sessions ended with this error.
- **Gemini reads the files you point it to in Read only mode.** agy's plan mode denied reading anything outside the project, such as `~/Downloads/prototype.html` named in a task. Folders of the files a message names by full path (`/…`, `~/…`, `file:///…`) are now passed as `--add-dir`, and the conversation keeps them for later turns. Top-level and system folders, the home folder and its dot-folders (`~/.ssh`, `~/.config`) are never added.
- Gemini runs that resume a conversation showed the whole conversation's tokens (e.g. "62.7M → 273k" for a 19-second run); they now show the run's own.
- Claude's `/usage` reset times like "1pm" that already passed today now mean tomorrow.

## 0.1.0

First public release.

- Team chat with Claude Code, Codex and Antigravity (Gemini) through their official CLIs, on your own subscriptions.
- Routing by complexity and area, with quota-aware agent choice.
- Team mode with a lead, parallel tasks and autopilot iterations.
- Brainstorms with a moderator summary, cross-vendor review, "Stronger" reruns.
- Subscription limits in the header, read from the CLIs without model calls.
- Read only / Edits / Full access modes; Restricted Mode support.
- English and Russian interface (`harness.language`).
