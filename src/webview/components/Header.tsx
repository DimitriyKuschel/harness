import { useEffect, useRef, useState } from 'react';
import { exhaustedUntil } from '../../core/quota';
import type { AgentView, LimitWindow, Prefs, TelegramView, ViewState } from '../../core/types';
import { formatReset, t } from '../../i18n';
import { AGENT_SHORT, cx, limitLevel, limitsTooltip, liveWindow, relativeTime } from '../util';
import { post } from '../vscode';

interface Props {
  state: ViewState;
  prefs: Prefs;
  onPrefs: (p: Prefs) => void;
}

export function Header({ state, prefs, onPrefs }: Props) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const { conversation, history } = state;
  const hasMessages = conversation.messages.length > 0;
  const s = t();

  return (
    <header className="header">
      <div className="bar-inner">
      <div className="header-row">
        <button className="title-button" onClick={() => setHistoryOpen((v) => !v)} title={s.header.history}>
          <span className="title-text">{hasMessages ? conversation.title : s.newChat}</span>
          <i className={cx('codicon', historyOpen ? 'codicon-chevron-up' : 'codicon-chevron-down')} />
        </button>
        <div className="spacer" />
        <TelegramButton view={state.telegram} />
        <button className="icon-button" title={s.newChat} onClick={() => post({ type: 'newChat' })}>
          <i className="codicon codicon-add" />
        </button>
        <button className="icon-button" title={s.header.settings} onClick={() => post({ type: 'command', command: 'settings' })}>
          <i className="codicon codicon-settings-gear" />
        </button>
      </div>

      <div className="team-strip">
        {state.agents.map((a) => (
          <AgentPill
            key={a.id}
            agent={a}
            pinned={prefs.models?.[a.id]}
            onPin={(model) => onPrefs({ ...prefs, models: { ...prefs.models, [a.id]: model } })}
          />
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

function TelegramButton({ view }: { view: TelegramView }) {
  const s = t().telegram;
  const bot = view.bot ?? '';
  const title =
    view.state === 'on' ? s.viewOn(bot) : view.state === 'pairing' ? s.viewPairing(bot) : view.state === 'elsewhere' ? s.viewElsewhere(bot, view.window ?? '') : s.viewOff;
  return (
    <button className={cx('icon-button', 'telegram', view.state)} title={title} onClick={() => post({ type: 'command', command: 'telegram' })}>
      <i className="codicon codicon-device-mobile" />
    </button>
  );
}

function AgentPill({ agent, pinned, onPin }: { agent: AgentView; pinned?: string; onPin: (model: string | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const off = !agent.installed || !agent.enabled;
  const { agents: a, limits } = t();
  const status = !agent.installed ? a.notInstalled : !agent.enabled ? a.disabled : agent.busy ? a.working : a.ready;
  const until = exhaustedUntil(agent.limits);
  const tooltip = [
    `${agent.label}${agent.version ? ` ${agent.version}` : ''} — ${status}`,
    !agent.installed && agent.error ? agent.error : '',
    until ? `${a.outOfQuota} (${formatReset(until)}): ${agent.limits?.exhausted?.message}` : '',
    agent.installed ? limitsTooltip(agent.limits) : '',
    pinned ? a.pinned(pinned) : '',
    off ? '' : a.clickForMenu,
  ]
    .filter(Boolean)
    .join('\n');

  return (
    <div className={cx('agent-card', `agent-${agent.id}`, off && 'off', agent.busy && 'busy', !!until && 'out', open && 'open')}>
      <div
        className="agent-card-face"
        title={open ? undefined : tooltip}
        onClick={() => (off ? post({ type: 'command', command: agent.installed ? 'settings' : 'refresh' }) : setOpen((v) => !v))}
      >
        <div className="agent-card-top">
          <span className="avatar small">{AGENT_SHORT[agent.id]}</span>
          <span className="agent-card-name">{agent.label}</span>
          {pinned && <i className="codicon codicon-pinned agent-card-pin" />}
        </div>
        {off ? (
          <div className="agent-card-status">{status}</div>
        ) : until ? (
          <div className="agent-card-status quota">
            <i className="codicon codicon-error" /> {a.outOfQuota}
          </div>
        ) : (
          <div className="meters">
            <Meter label={limits.meterFiveHours} w={agent.limits?.fiveHour} />
            <Meter label={limits.meterWeek} w={agent.limits?.weekly} />
          </div>
        )}
      </div>
      {open && <AgentMenu agent={agent} pinned={pinned} until={until} onPin={onPin} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** The agent card's menu: pin a model, re-read the quota, put an agent marked as out of quota back to work. */
function AgentMenu({ agent, pinned, until, onPin, onClose }: { agent: AgentView; pinned?: string; until?: number; onPin: (model: string | undefined) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const a = t().agents;
  const choose = (model: string | undefined) => {
    onPin(model);
    onClose();
  };
  const models = pinned && !agent.models.includes(pinned) ? [pinned, ...agent.models] : agent.models;
  return (
    <div className="picker-menu agent-menu" ref={ref} role="menu">
      <div className="picker-title">{a.modelMenu}</div>
      <button className="picker-option" role="menuitemradio" aria-checked={!pinned} onClick={() => choose(undefined)}>
        <i className={cx('codicon', pinned ? 'codicon-blank' : 'codicon-check')} />
        <span>
          <span className="picker-option-label">{a.modelAuto}</span>
          <span className="picker-option-desc">{a.modelAutoHint}</span>
        </span>
      </button>
      {models.map((m) => (
        <button key={m} className="picker-option" role="menuitemradio" aria-checked={pinned === m} onClick={() => choose(m)}>
          <i className={cx('codicon', pinned === m ? 'codicon-check' : 'codicon-blank')} />
          <span className="picker-option-label mono">{m}</span>
        </button>
      ))}
      <div className="picker-separator" />
      {until && (
        <button className="picker-option" role="menuitem" onClick={() => (post({ type: 'resetQuota', agent: agent.id }), onClose())}>
          <i className="codicon codicon-play" />
          <span>
            <span className="picker-option-label">{a.backToWork}</span>
            <span className="picker-option-desc">{a.backToWorkHint(formatReset(until))}</span>
          </span>
        </button>
      )}
      <button className="picker-option" role="menuitem" onClick={() => (post({ type: 'command', command: 'limits' }), onClose())}>
        <i className="codicon codicon-refresh" />
        <span className="picker-option-label">{a.refreshLimits}</span>
      </button>
    </div>
  );
}

/** Remaining share of one quota window, battery-style. `null`: the plan has no such window. */
function Meter({ label, w }: { label: string; w?: LimitWindow | null }) {
  const live = liveWindow(w);
  const left = live ? Math.round(100 - Math.min(100, Math.max(0, live.usedPercent))) : undefined;
  const level = left !== undefined ? limitLevel(100 - left) : undefined;
  const s = t().limits;
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
      <span className={cx('meter-value', level)} title={w === null ? s.meterNone : left !== undefined ? s.meterLeft(left) : s.meterNoData}>
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

  const s = t();
  return (
    <div className="history-menu" ref={ref}>
      <button
        className="history-item new"
        onClick={() => {
          post({ type: 'newChat' });
          onClose();
        }}
      >
        <i className="codicon codicon-add" /> {s.newChat}
      </button>
      {items.length === 0 && <div className="history-empty">{s.header.historyEmpty}</div>}
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
          <button className="icon-button subtle" title={s.header.delete} onClick={() => post({ type: 'deleteChat', id: h.id })}>
            <i className="codicon codicon-trash" />
          </button>
        </div>
      ))}
    </div>
  );
}
