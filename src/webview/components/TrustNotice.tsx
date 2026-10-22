import { post } from '../vscode';

/** Replaces the composer in Restricted Mode: agents run commands in the project, so VS Code must trust it first. */
export function TrustNotice({ workspace }: { workspace?: string }) {
  return (
    <div className="composer">
      <div className="bar-inner trust-notice">
        <i className="codicon codicon-shield" />
        <div className="trust-text">
          <b>Папка {workspace ? `«${workspace}» ` : ''}открыта в ограниченном режиме</b>
          <span>Агенты запускают команды и правят файлы, поэтому VS Code разрешает им работать только в доверенных папках.</span>
        </div>
        <button className="primary-button" onClick={() => post({ type: 'command', command: 'trust' })}>
          Доверять папке
        </button>
      </div>
    </div>
  );
}
