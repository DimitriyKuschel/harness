import { useEffect, useState } from 'react';
import { stripPlanBlock } from '../../core/plan';
import {
  AGENT_LABELS,
  type ChatMessage,
  type MessageKind,
  type Part,
  type PlanTask,
  type RouteInfo,
  type TaskStatus,
  type TeamStatus,
  type ToolPart,
  messageText,
} from '../../core/types';
import { AGENT_META, cx, formatDuration, formatTokens, isFileTool, toolIcon } from '../util';
import { post } from '../vscode';
import { Markdown } from './Markdown';

const KIND_LABELS: Partial<Record<MessageKind, string>> = {
  brainstorm: 'Брейншторм',
  debate: 'Раунд обсуждения',
  synthesis: 'Сводка модератора',
  review: 'Ревью',
  fix: 'Исправления по ревью',
  plan: 'План команды',
  task: 'Задача',
  report: 'Проверка лида',
};

const TEAM_STATUS: Record<TeamStatus['status'], { icon: string; label: string }> = {
  done: { icon: 'pass-filled', label: 'Цель достигнута' },
  continue: { icon: 'sync', label: 'Нужна ещё итерация' },
  blocked: { icon: 'question', label: 'Нужно решение CEO' },
};

const TASK_STATUS: Record<TaskStatus, { icon: string; label: string }> = {
  pending: { icon: 'circle-large-outline', label: 'ждёт очереди' },
  running: { icon: 'loading codicon-modifier-spin', label: 'в работе' },
  done: { icon: 'pass-filled', label: 'готово' },
  error: { icon: 'error', label: 'ошибка' },
  stopped: { icon: 'debug-stop', label: 'остановлена' },
  skipped: { icon: 'circle-slash', label: 'пропущена: не выполнена зависимость' },
};

const TIER_LABELS: Record<RouteInfo['tier'], string> = {
  trivial: 'простая',
  standard: 'обычная',
  hard: 'сложная',
  critical: 'критичная',
};

const DOMAIN_LABELS: Record<NonNullable<RouteInfo['domain']>, string> = {
  code: 'код',
  frontend: 'фронтенд',
  design: 'дизайн',
  research: 'исследование',
  writing: 'тексты',
  marketing: 'маркетинг',
  planning: 'планирование',
  data: 'данные',
  other: 'общее',
};

const AUTONOMY_LABELS: Record<RouteInfo['autonomy'], string> = {
  readonly: 'только чтение',
  auto: 'правки',
  full: 'полный доступ',
};

interface Props {
  message: ChatMessage;
  /** Team or another message is running: actions that start work are disabled. */
  busy: boolean;
  canReview: boolean;
}

export function MessageView({ message, busy, canReview }: Props) {
  if (message.role === 'user') return <UserMessage message={message} />;
  if (message.role === 'system') {
    return (
      <div className="notice">
        <i className="codicon codicon-info" /> {messageText(message)}
      </div>
    );
  }
  return <AgentMessage message={message} busy={busy} canReview={canReview} />;
}

function UserMessage({ message }: { message: ChatMessage }) {
  return (
    <div className="msg user">
      <div className="bubble">
        <Markdown text={messageText(message)} />
      </div>
    </div>
  );
}

function AgentMessage({ message: m, busy, canReview }: Props) {
  const agent = m.agent;
  const live = m.status === 'streaming' || m.status === 'routing';
  const raw = messageText(m);
  // Plans and checks end with machine-readable blocks for the orchestrator; hide them while they stream too.
  const isPlan = m.kind === 'plan' || m.kind === 'report';
  const text = isPlan ? stripPlanBlock(raw) : raw;
  const parts = isPlan ? m.parts.map((p) => (p.type === 'text' ? { ...p, text: stripPlanBlock(p.text) } : p)) : m.parts;
  const kindLabel = m.kind ? KIND_LABELS[m.kind] : undefined;
  const collapsible = !live && (m.kind === 'brainstorm' || m.kind === 'debate') && text.length > 1400;
  const [expanded, setExpanded] = useState(false);

  return (
    <div className={cx('msg', 'agent', agent && `agent-${agent}`, m.kind === 'synthesis' && 'synthesis', m.status === 'error' && 'failed')}>
      <div className={cx('avatar', live && 'pulse')}>
        {agent ? AGENT_META[agent].short : <i className="codicon codicon-loading codicon-modifier-spin" />}
      </div>
      <div className="msg-body">
        <div className="msg-head">
          <span className="msg-name">{agent ? AGENT_LABELS[agent] : 'Роутер'}</span>
          {kindLabel && <span className="kind-badge">{kindLabel}</span>}
          {m.route && <RouteChip route={m.route} />}
        </div>
        {m.subtitle && <div className="msg-subtitle">{m.subtitle}</div>}

        {m.status === 'routing' && <div className="thinking">Подбираю исполнителя, модель и effort…</div>}
        {m.route && (m.route.via === 'llm' || m.route.via === 'heuristic') && <RouteReason route={m.route} />}

        <div className={cx('msg-content', collapsible && !expanded && 'collapsed')}>
          <Parts parts={parts} live={live} />
        </div>
        {isPlan && live && raw.includes('```team-') && (
          <div className="thinking">
            {raw.includes('```team-plan') ? 'Распределяю задачи' : 'Подвожу итог'}
            <span className="dots" />
          </div>
        )}
        {m.teamStatus && (
          <div className={cx('team-status', m.teamStatus.status)}>
            <i className={`codicon codicon-${TEAM_STATUS[m.teamStatus.status].icon}`} />
            <b>{TEAM_STATUS[m.teamStatus.status].label}</b>
            {m.teamStatus.reason && <span>— {m.teamStatus.reason}</span>}
          </div>
        )}
        {m.plan && <PlanCard tasks={m.plan} title={m.kind === 'report' ? `Следующая итерация (${(m.iteration ?? 1) + 1})` : undefined} />}
        {collapsible && (
          <button className="link-button" onClick={() => setExpanded((v) => !v)}>
            {expanded ? 'Свернуть' : 'Показать полностью'}
          </button>
        )}

        {m.status === 'streaming' && !text && !m.parts.some((p) => p.type === 'tool' && p.status === 'running') && (
          <div className="thinking">
            Думает<span className="dots" />
          </div>
        )}
        {live && <Elapsed since={m.createdAt} />}

        {m.status === 'error' && (
          <div className="error-box">
            <i className="codicon codicon-error" />
            <span>{m.error || 'Ошибка'}</span>
          </div>
        )}
        {m.status === 'stopped' && <div className="stopped">Остановлено</div>}

        {!live && <Footer m={m} busy={busy} canReview={canReview} text={text} />}
      </div>
    </div>
  );
}

function RouteChip({ route }: { route: RouteInfo }) {
  const model = route.resolvedModel ?? route.model ?? 'по умолчанию';
  const title = [
    `Модель: ${model}`,
    `Effort: ${route.effort}`,
    `Сложность: ${TIER_LABELS[route.tier]}${route.domain ? ` · область: ${DOMAIN_LABELS[route.domain]}` : ''}`,
    `Доступ: ${AUTONOMY_LABELS[route.autonomy]}`,
    `Причина: ${route.reason}`,
  ].join('\n');
  return (
    <span className="route-chip" title={title}>
      {route.model ?? shortModel(model)} · {route.effort}
      {route.autonomy === 'readonly' && <i className="codicon codicon-lock" />}
    </span>
  );
}

function RouteReason({ route }: { route: RouteInfo }) {
  return (
    <div className="route-reason">
      <i className={cx('codicon', route.via === 'llm' ? 'codicon-sparkle' : 'codicon-symbol-ruler')} />
      {TIER_LABELS[route.tier]} задача{route.domain && route.domain !== 'other' ? ` · ${DOMAIN_LABELS[route.domain]}` : ''} — {route.reason}
    </div>
  );
}

function Parts({ parts, live }: { parts: Part[]; live: boolean }) {
  // Consecutive tool calls collapse into one group between paragraphs of text.
  const blocks: ({ kind: 'text'; text: string } | { kind: 'tools'; tools: ToolPart[] })[] = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.trim()) blocks.push({ kind: 'text', text: p.text });
    } else {
      const last = blocks[blocks.length - 1];
      if (last?.kind === 'tools') last.tools.push(p);
      else blocks.push({ kind: 'tools', tools: [p] });
    }
  }
  return (
    <>
      {blocks.map((b, i) =>
        b.kind === 'text' ? <Markdown key={i} text={b.text} /> : <ToolGroup key={i} tools={b.tools} live={live && i === blocks.length - 1} />,
      )}
    </>
  );
}

function ToolGroup({ tools, live }: { tools: ToolPart[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const running = tools.filter((t) => t.status === 'running');
  const failed = tools.filter((t) => t.status === 'error').length;
  const current = running[running.length - 1] ?? (live ? tools[tools.length - 1] : undefined);

  return (
    <div className={cx('tool-group', open && 'open')}>
      <button className="tool-summary" onClick={() => setOpen((v) => !v)}>
        <i className={cx('codicon', open ? 'codicon-chevron-down' : 'codicon-chevron-right')} />
        {current ? (
          <>
            <i className="codicon codicon-loading codicon-modifier-spin" />
            <span className="tool-name">{current.name}</span>
            {current.detail && <span className="tool-detail">{current.detail}</span>}
          </>
        ) : (
          <span>
            {tools.length} {plural(tools.length, 'действие', 'действия', 'действий')}
            {failed > 0 && <span className="tool-failed"> · {failed} с ошибкой</span>}
          </span>
        )}
      </button>
      {open && (
        <ul className="tool-list">
          {tools.map((t) => (
            <li key={t.id} className={cx('tool', t.status)}>
              <i className={cx('codicon', `codicon-${toolIcon(t.name)}`)} />
              <span className="tool-name">{t.name}</span>
              {t.detail &&
                (isFileTool(t.name) ? (
                  <button className="tool-detail file-ref" onClick={() => post({ type: 'openFile', path: t.detail! })}>
                    {t.detail}
                  </button>
                ) : (
                  <span className="tool-detail">{t.detail}</span>
                ))}
              <i
                className={cx(
                  'codicon',
                  'tool-status',
                  t.status === 'running' ? 'codicon-loading codicon-modifier-spin' : t.status === 'ok' ? 'codicon-check' : 'codicon-error',
                )}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PlanCard({ tasks, title = 'Задачи команды' }: { tasks: PlanTask[]; title?: string }) {
  const done = tasks.filter((t) => t.status === 'done').length;
  return (
    <div className="plan-card">
      <div className="plan-head">
        <i className="codicon codicon-checklist" />
        {title} · {done}/{tasks.length}
      </div>
      <ul className="plan-tasks">
        {tasks.map((t, i) => {
          const st = TASK_STATUS[t.status];
          const deps = t.dependsOn.map((d) => tasks.findIndex((x) => x.id === d) + 1).filter((n) => n > 0);
          const meta = [t.scope, deps.length ? `после ${deps.join(', ')}` : ''].filter(Boolean).join(' · ');
          return (
            <li key={t.id} className={cx('plan-task', t.status, `agent-${t.agent}`)}>
              <i className={`codicon codicon-${st.icon} task-status`} title={st.label} />
              <span className="avatar small" title={AGENT_LABELS[t.agent]}>
                {AGENT_META[t.agent].short}
              </span>
              <div className="task-text">
                <button
                  className="task-title"
                  disabled={!t.messageId}
                  title={t.messageId ? 'Перейти к выполнению' : st.label}
                  onClick={() => document.getElementById(`msg-${t.messageId}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  {i + 1}. {t.title}
                </button>
                {meta && <span className="task-meta">{meta}</span>}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Footer({ m, busy, canReview, text }: { m: ChatMessage; busy: boolean; canReview: boolean; text: string }) {
  const actions: { icon: string; label: string; title: string; run: () => void; primary?: boolean }[] = [];
  // Plans, reviews and summaries are about other work; plan tasks and the report keep their own brief.
  const work = m.kind !== 'synthesis' && m.kind !== 'review' && m.kind !== 'plan';
  const redoable = work && m.kind !== 'task' && m.kind !== 'report';

  if (m.status === 'error' || m.status === 'stopped') {
    actions.push({ icon: 'refresh', label: 'Повторить', title: 'Запустить ещё раз тем же агентом', run: () => post({ type: 'rerun', id: m.id, stronger: false }), primary: true });
  }
  if (m.status === 'done') {
    if (m.kind === 'review') {
      actions.push({ icon: 'tools', label: 'Исправить', title: 'Передать замечания автору', run: () => post({ type: 'fix', id: m.id }), primary: true });
    }
    if (m.kind === 'report' && m.goal && m.teamStatus?.status !== 'done') {
      const id = m.id;
      const ready = m.plan?.length && m.plan.every((t) => t.status === 'pending');
      actions.push({
        icon: 'debug-continue',
        label: 'Ещё итерация',
        title: ready ? 'Запустить следующую итерацию по плану лида' : 'Лид составит план следующей итерации, команда его выполнит',
        run: () => post({ type: 'continueTeam', id }),
        primary: m.teamStatus?.status === 'continue',
      });
    }
    if (m.kind === 'synthesis' && m.round) {
      const round = m.round;
      actions.push({ icon: 'comment-discussion', label: 'Ещё раунд', title: 'Каждый участник критикует ответы коллег, затем новая сводка', run: () => post({ type: 'debate', round }) });
    }
    if (work && canReview) {
      actions.push({ icon: 'eye', label: 'Ревью', title: 'Проверка агентом другого вендора', run: () => post({ type: 'review', id: m.id }) });
    }
    if (redoable && m.route && m.route.tier !== 'critical') {
      actions.push({ icon: 'arrow-up', label: 'Сильнее', title: 'Переделать этим же агентом на уровень сложнее (сильнее модель / больше effort)', run: () => post({ type: 'rerun', id: m.id, stronger: true }) });
    }
  }

  return (
    <div className="msg-footer">
      <div className="msg-actions">
        {actions.map((a) => (
          <button key={a.label} className={cx('action', a.primary && 'primary')} title={a.title} disabled={busy} onClick={a.run}>
            <i className={`codicon codicon-${a.icon}`} />
            {a.label}
          </button>
        ))}
        {text && <CopyButton text={text} />}
      </div>
      <div className="msg-stats">
        {m.usage && (
          <span title="Токены: вход (вместе с кэшем) / выход">
            {formatTokens(m.usage.input)} → {formatTokens(m.usage.output)}
          </span>
        )}
        {m.endedAt && <span>{formatDuration(m.endedAt - m.createdAt)}</span>}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="action"
      title="Копировать ответ"
      onClick={() => {
        post({ type: 'copy', text });
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      <i className={cx('codicon', done ? 'codicon-check' : 'codicon-copy')} />
    </button>
  );
}

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <div className="elapsed">{formatDuration(now - since)}</div>;
}

function shortModel(model: string): string {
  return model.replace(/^claude-/, '');
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

export function RoundHeader({ kind, agents }: { kind: MessageKind; agents: string[] }) {
  return (
    <div className="round-header">
      <span className="round-line" />
      <span className="round-label">
        <i className={cx('codicon', kind === 'debate' ? 'codicon-comment-discussion' : 'codicon-lightbulb')} />
        {kind === 'debate' ? 'Раунд обсуждения' : 'Брейншторм'} · {agents.join(', ')}
      </span>
      <span className="round-line" />
    </div>
  );
}
