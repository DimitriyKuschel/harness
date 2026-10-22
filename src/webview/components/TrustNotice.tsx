import { t } from '../../i18n';
import { post } from '../vscode';

/** Replaces the composer in Restricted Mode: agents run commands in the project, so VS Code must trust it first. */
export function TrustNotice({ workspace }: { workspace?: string }) {
  const s = t().trust;
  return (
    <div className="composer">
      <div className="bar-inner trust-notice">
        <i className="codicon codicon-shield" />
        <div className="trust-text">
          <b>{s.title(workspace)}</b>
          <span>{s.body}</span>
        </div>
        <button className="primary-button" onClick={() => post({ type: 'command', command: 'trust' })}>
          {s.button}
        </button>
      </div>
    </div>
  );
}
