import type { AgentView, Mode } from '../../core/types';
import { AGENT_META, cx } from '../util';
import { post } from '../vscode';

const SUGGESTIONS: { text: string; mode: Mode; icon: string }[] = [
  { icon: 'lightbulb', mode: 'brainstorm', text: 'Как улучшить архитектуру этого проекта? Какие главные риски?' },
  { icon: 'beaker', mode: 'auto', text: '@codex запусти тесты и почини то, что падает' },
  { icon: 'checklist', mode: 'auto', text: 'Составь план развития проекта на месяц с приоритетами' },
  { icon: 'megaphone', mode: 'brainstorm', text: 'Предложите SEO- и маркетинговую стратегию для запуска' },
];

export function EmptyState({
  agents,
  workspace,
  trusted,
  onPick,
}: {
  agents: AgentView[];
  workspace?: string;
  trusted: boolean;
  onPick: (text: string, mode: Mode) => void;
}) {
  const ready = agents.filter((a) => a.installed && a.enabled);
  return (
    <div className="empty">
      <div className="empty-avatars">
        {agents.map((a) => (
          <span key={a.id} className={cx('avatar', 'large', `agent-${a.id}`, !(a.installed && a.enabled) && 'off')}>
            {AGENT_META[a.id].short}
          </span>
        ))}
      </div>
      <h2>Ваша AI-команда {ready.length ? 'на месте' : 'ещё не собрана'}</h2>
      <p className="empty-lead">
        Опишите задачу — роутер сам выберет исполнителя, модель и effort, чтобы не тратить лимиты зря.
        {workspace && (
          <>
            {' '}
            Работаем в проекте <b>{workspace}</b>.
          </>
        )}
      </p>

      <div className="team-cards">
        {agents.map((a) => (
          <div key={a.id} className={cx('team-card', `agent-${a.id}`, !(a.installed && a.enabled) && 'off')}>
            <span className={cx('avatar', 'small')}>{AGENT_META[a.id].short}</span>
            <div>
              <div className="team-card-name">
                {a.label} {a.version && <span className="muted">{a.version}</span>}
              </div>
              <div className="team-card-hint">
                {a.installed ? (a.enabled ? AGENT_META[a.id].tagline : 'выключен в настройках') : a.id === 'gemini' ? 'установите Antigravity CLI (agy)' : 'CLI не найден'}
              </div>
            </div>
          </div>
        ))}
      </div>

      {ready.length === 0 && (
        <button className="primary-button" onClick={() => post({ type: 'command', command: 'refresh' })}>
          <i className="codicon codicon-refresh" /> Проверить агентов ещё раз
        </button>
      )}

      {trusted && (
        <>
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.text} className="suggestion" onClick={() => onPick(s.text, s.mode)}>
                <i className={`codicon codicon-${s.icon}`} />
                <span>{s.text}</span>
                {s.mode === 'brainstorm' && <span className="suggestion-tag">брейншторм</span>}
              </button>
            ))}
          </div>

          <div className="tips">
            <span>
              <kbd>Enter</kbd> отправить
            </span>
            <span>
              <kbd>Shift</kbd>+<kbd>Enter</kbd> новая строка
            </span>
            <span>
              <kbd>@</kbd> позвать агента
            </span>
            <span>
              <kbd>Esc</kbd> остановить
            </span>
          </div>
        </>
      )}
    </div>
  );
}
