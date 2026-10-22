import type { AgentView, Mode } from '../../core/types';
import { t, type Strings } from '../../i18n';
import { AGENT_SHORT, cx } from '../util';
import { post } from '../vscode';

const SUGGESTIONS: { key: keyof Strings['empty']['suggestions']; mode: Mode; icon: string }[] = [
  { icon: 'lightbulb', mode: 'brainstorm', key: 'architecture' },
  { icon: 'beaker', mode: 'auto', key: 'tests' },
  { icon: 'checklist', mode: 'auto', key: 'roadmap' },
  { icon: 'megaphone', mode: 'brainstorm', key: 'marketing' },
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
  const s = t();
  return (
    <div className="empty">
      <div className="empty-avatars">
        {agents.map((a) => (
          <span key={a.id} className={cx('avatar', 'large', `agent-${a.id}`, !(a.installed && a.enabled) && 'off')}>
            {AGENT_SHORT[a.id]}
          </span>
        ))}
      </div>
      <h2>{s.empty.title(ready.length > 0)}</h2>
      <p className="empty-lead">
        {s.empty.lead}
        {workspace && (
          <>
            {' '}
            {s.empty.project} <b>{workspace}</b>.
          </>
        )}
      </p>

      <div className="team-cards">
        {agents.map((a) => (
          <div key={a.id} className={cx('team-card', `agent-${a.id}`, !(a.installed && a.enabled) && 'off')}>
            <span className={cx('avatar', 'small')}>{AGENT_SHORT[a.id]}</span>
            <div>
              <div className="team-card-name">
                {a.label} {a.version && <span className="muted">{a.version}</span>}
              </div>
              <div className="team-card-hint">
                {a.installed ? (a.enabled ? s.agents.taglines[a.id] : s.agents.disabledInSettings) : a.id === 'gemini' ? s.agents.installAgy : s.agents.cliNotFound}
              </div>
            </div>
          </div>
        ))}
      </div>

      {ready.length === 0 && (
        <button className="primary-button" onClick={() => post({ type: 'command', command: 'refresh' })}>
          <i className="codicon codicon-refresh" /> {s.empty.recheck}
        </button>
      )}

      {trusted && (
        <>
          <div className="suggestions">
            {SUGGESTIONS.map((sg) => (
              <button key={sg.key} className="suggestion" onClick={() => onPick(s.empty.suggestions[sg.key], sg.mode)}>
                <i className={`codicon codicon-${sg.icon}`} />
                <span>{s.empty.suggestions[sg.key]}</span>
                {sg.mode === 'brainstorm' && <span className="suggestion-tag">{s.empty.brainstormTag}</span>}
              </button>
            ))}
          </div>

          <div className="tips">
            <span>
              <kbd>Enter</kbd> {s.empty.tips.send}
            </span>
            <span>
              <kbd>Shift</kbd>+<kbd>Enter</kbd> {s.empty.tips.newline}
            </span>
            <span>
              <kbd>@</kbd> {s.empty.tips.mention}
            </span>
            <span>
              <kbd>Esc</kbd> {s.empty.tips.stop}
            </span>
          </div>
        </>
      )}
    </div>
  );
}
