export const AGENT_IDS = ['claude', 'codex', 'gemini'] as const;
export type AgentId = (typeof AGENT_IDS)[number];

export const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export const TIERS = ['trivial', 'standard', 'hard', 'critical'] as const;
export type Tier = (typeof TIERS)[number];

export const DOMAINS = ['code', 'frontend', 'design', 'research', 'writing', 'marketing', 'planning', 'data', 'other'] as const;
export type Domain = (typeof DOMAINS)[number];

/** What the agent may do in the workspace. */
export type Autonomy = 'readonly' | 'auto' | 'full';
/** How the CEO's message is handled. */
export type Mode = 'auto' | 'team' | 'brainstorm';
/** Spend profile: shifts the routed tier down (eco) or up (max). */
export type Profile = 'eco' | 'balanced' | 'max';

export interface ModelChoice {
  model?: string;
  effort: Effort;
}

export interface LimitWindow {
  /** 0..100 */
  usedPercent: number;
  /** Unix seconds. */
  resetsAt?: number;
}

export interface AgentLimits {
  /** `null`: the plan has no such window (Codex on Pro only has a weekly one). */
  fiveHour?: LimitWindow | null;
  weekly?: LimitWindow | null;
  updatedAt: number;
}

export interface Usage {
  input: number;
  output: number;
  cached?: number;
}

/** A single call into an agent CLI. */
export interface RunRequest {
  prompt: string;
  cwd: string;
  model?: string;
  effort?: Effort;
  autonomy: Autonomy;
  /** Resume this agent-native session/thread. */
  sessionId?: string;
  /** Extra system instructions (only applied when a new session starts). */
  systemPrompt?: string;
  /** Ask for structured output matching this JSON schema. */
  jsonSchema?: object;
  /** One-shot call: no tools, no saved session (router, synthesis). */
  ephemeral?: boolean;
}

/** Normalised stream events emitted by every adapter. */
export type AgentEvent =
  | { kind: 'session'; id: string }
  | { kind: 'model'; model: string }
  /** `newBlock`: this text starts a new paragraph/turn, not a continuation. */
  | { kind: 'text'; delta: string; newBlock?: boolean }
  | { kind: 'tool'; id: string; name: string; detail?: string }
  | { kind: 'tool_done'; id: string; ok: boolean }
  | { kind: 'usage'; usage: Usage }
  | { kind: 'limits'; limits: AgentLimits }
  | { kind: 'error'; message: string };

export interface RunOutcome {
  ok: boolean;
  text: string;
  sessionId?: string;
  structured?: unknown;
  error?: string;
  usage?: Usage;
}

export interface AgentStatus {
  id: AgentId;
  installed: boolean;
  version?: string;
  path?: string;
  error?: string;
}

export interface AgentAdapter {
  readonly id: AgentId;
  detect(): Promise<AgentStatus>;
  run(req: RunRequest, onEvent: (e: AgentEvent) => void, signal: AbortSignal): Promise<RunOutcome>;
  /** Current subscription quota, read without a model call. */
  readLimits?(): Promise<AgentLimits | undefined>;
}

// ---- Conversation model (shared with the webview) ----

export interface ToolPart {
  type: 'tool';
  id: string;
  name: string;
  detail?: string;
  status: 'running' | 'ok' | 'error';
}
export interface TextPart {
  type: 'text';
  text: string;
}
export type Part = TextPart | ToolPart;

export interface RouteInfo {
  agent: AgentId;
  model?: string;
  effort: Effort;
  tier: Tier;
  domain?: Domain;
  autonomy: Autonomy;
  reason: string;
  via: 'mention' | 'llm' | 'heuristic' | 'system';
  /** Full model id reported by the CLI (e.g. alias "opus" → "claude-opus-5-5"). */
  resolvedModel?: string;
}

export type MessageKind = 'answer' | 'brainstorm' | 'debate' | 'synthesis' | 'review' | 'fix' | 'plan' | 'task' | 'report' | 'notice';

export type TaskStatus = 'pending' | 'running' | 'done' | 'error' | 'stopped' | 'skipped';

/** The lead's verdict after a team iteration. */
export interface TeamStatus {
  status: 'done' | 'continue' | 'blocked';
  reason: string;
}

/** One assignment from the lead's team plan. */
export interface PlanTask {
  id: string;
  title: string;
  agent: AgentId;
  domain: Domain;
  tier: Tier;
  /** Self-contained brief for the assignee. */
  task: string;
  /** Files or folders this task owns, so colleagues working in parallel don't collide. */
  scope?: string;
  /** Tasks that must finish first. */
  dependsOn: string[];
  status: TaskStatus;
  /** The message that executes the task. */
  messageId?: string;
}
export type MessageStatus = 'routing' | 'streaming' | 'done' | 'error' | 'stopped';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'system';
  agent?: AgentId;
  kind?: MessageKind;
  /** Message this one answers (user message, or the reviewed/brainstorm message). */
  replyTo?: string;
  /** Brainstorm round id: groups parallel answers and their synthesis. */
  round?: string;
  parts: Part[];
  status: MessageStatus;
  route?: RouteInfo;
  /** Short line under the header, e.g. a plan task title. */
  subtitle?: string;
  /** kind 'plan': the lead's assignments and their progress. */
  plan?: PlanTask[];
  /** kind 'task': which plan task this message executes (the plan is `replyTo`). */
  taskId?: string;
  /** kind 'task' | 'report': the brief the agent got, so the run can be repeated. */
  prompt?: string;
  /** Team runs: the CEO message that set the goal, and which iteration this belongs to. */
  goal?: string;
  iteration?: number;
  /** kind 'report': the lead's verdict. */
  teamStatus?: TeamStatus;
  usage?: Usage;
  error?: string;
  createdAt: number;
  endedAt?: number;
}

export interface AgentSession {
  id: string;
  /** Index of the last conversation message this agent has been shown. */
  seen: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
  sessions: Partial<Record<AgentId, AgentSession>>;
}

export interface Prefs {
  mode: Mode;
  profile: Profile;
  autonomy: Autonomy;
  /** Team runs keep iterating (plan → tasks → check) until the lead says the goal is reached. */
  autopilot: boolean;
}

export interface AgentView {
  id: AgentId;
  label: string;
  installed: boolean;
  enabled: boolean;
  version?: string;
  error?: string;
  limits?: AgentLimits;
  busy: boolean;
}

export interface ViewState {
  conversation: Conversation;
  history: { id: string; title: string; updatedAt: number }[];
  agents: AgentView[];
  running: boolean;
  /** Messages the CEO sent while the team was busy. */
  queue: string[];
  prefs: Prefs;
  workspace?: string;
  /** False in VS Code's Restricted Mode: agents must not run until the folder is trusted. */
  trusted: boolean;
}

export function messageText(m: ChatMessage): string {
  return m.parts
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('\n\n')
    .trim();
}
