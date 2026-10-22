import { useEffect, useRef, useState } from 'react';
import type { AgentView, LimitWindow, ViewState } from '../../core/types';
import { AGENT_META, cx, limitLevel, limitsTooltip, liveWindow, relativeTime } from '../util';
import { post } from '../vscode';

export function Header({ state }: { state: ViewState }) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { conversation, history } = state;
  const hasMessages = conversation.messages.length > 0;

  return (
    <header className="header">
      <div className="bar-inner">
      <div className="header-row">
        <button className="title-button" onClick={() => setHistoryOpen((v) => !v)} title="История чатов">
          <span className="title-text">{hasMessages ? conversation.title : 'Новый чат'}</span>
          <i className={cx('codicon', historyOpen ? 'codicon-chevron-up' : 'codicon-chevron-down')} />
        </button>
        <div className="spacer" />
        <button className="icon-button" title="Новый чат" onClick={() => post({ type: 'newChat' })}>
          <i className="codicon codicon-add" />
        </button>
        <button className="icon-button" title="Настройки роутинга и моделей" onClick={() => post({ type: 'command', command: 'settings' })}>
          <i className="codicon codicon-settings-gear" />
        </button>
      </div>

      <div className="team-strip">
        {state.agents.map((a) => (
          <AgentPill key={a.id} agent={a} />
        ))}
      </div>

      {historyOpen && (
        <HistoryMenu
          items={history}
          currentId={conversation.id}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      </div>
    </header>
  );
}

function AgentPill({ agent }: { agent: AgentView }) {
  const off = !agent.installed || !agent.enabled;
  const status = !agent.installed ? 'не установлен' : !agent.enabled ? 'выключен' : agent.busy ? 'работает…' : 'готов';
  const tooltip = [
    `${agent.label}${agent.version ? ` ${agent.version}` : ''} — ${status}`,
    !agent.installed && agent.error ? agent.error : '',
    agent.installed ? limitsTooltip(agent.limits) : '',
    off ? '' : 'Нажмите, чтобы обновить',
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div
      className={cx('agent-card', `agent-${agent.id}`, off && 'off', agent.busy && 'busy')}
      title={tooltip}
      onClick={() => post({ type: 'command', command: off ? (agent.installed ? 'settings' : 'refresh') : 'limits' })}
    >
      <div className="agent-card-top">
        <span className="avatar small">{AGENT_META[agent.id].short}</span>
        <span className="agent-card-name">{agent.label}</span>
      </div>
      {off ? (
        <div className="agent-card-status">{status}</div>
      ) : (
        <div className="meters">
          <Meter label="5 ч" w={agent.limits?.fiveHour} />
          <Meter label="нед" w={agent.limits?.weekly} />
        </div>
      )}
    </div>
  );
}

/** Remaining share of one quota window, battery-style. `null`: the plan has no such window. */
function Meter({ label, w }: { label: string; w?: LimitWindow | null }) {
  const live = liveWindow(w);
  const left = live ? Math.round(100 - Math.min(100, Math.max(0, live.usedPercent))) : undefined;
  const level = left !== undefined ? limitLevel(100 - left) : undefined;
  return (
    <span className="meter">
      <span className="meter-label">{label}</span>
      <span className="meter-track">
        {w === null ? (
          <span className="meter-fill none" />
        ) : (
          left !== undefined && <span className={cx('meter-fill', level)} style={{ width: `${left}%` }} />
        )}
      </span>
      <span className={cx('meter-value', level)} title={w === null ? 'Такого лимита у тарифа нет' : left !== undefined ? `Осталось ${left}%` : 'Нет данных'}>
        {w === null ? '∞' : left !== undefined ? `${left}%` : '—'}
      </span>
    </span>
  );
}

function HistoryMenu({ items, currentId, onClose }: { items: ViewState['history']; currentId: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest('.title-button')) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div className="history-menu" ref={ref}>
      <button
        className="history-item new"
        onClick={() => {
          post({ type: 'newChat' });
          onClose();
        }}
      >
        <i className="codicon codicon-add" /> Новый чат
      </button>
      {items.length === 0 && <div className="history-empty">Здесь появятся прошлые обсуждения</div>}
      {items.map((h) => (
        <div key={h.id} className={cx('history-item', h.id === currentId && 'current')}>
          <button
            className="history-open"
            onClick={() => {
              post({ type: 'openChat', id: h.id });
              onClose();
            }}
          >
            <span className="history-title">{h.title}</span>
            <span className="history-time">{relativeTime(h.updatedAt)}</span>
          </button>
          <button className="icon-button subtle" title="Удалить" onClick={() => post({ type: 'deleteChat', id: h.id })}>
            <i className="codicon codicon-trash" />
          </button>
        </div>
      ))}
    </div>
  );
}
