import * as vscode from 'vscode';
import { Controller } from './host/controller';

let controller: Controller | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Harness', { log: true });
  controller = new Controller(context, log);
  const c = controller;

  context.subscriptions.push(
    log,
    c,
    vscode.window.registerWebviewViewProvider(
      'harness.chat',
      {
        resolveWebviewView(view) {
          const detach = c.attach(view.webview);
          view.onDidDispose(() => detach.dispose());
        },
      },
      { webviewOptions: { retainContextWhenHidden: true } },
    ),
    vscode.commands.registerCommand('harness.newChat', () => c.newChat()),
    vscode.commands.registerCommand('harness.openInEditor', () => c.openInEditor()),
    vscode.commands.registerCommand('harness.refreshAgents', () => c.refreshAgents().then(() => c.refreshLimits(undefined, true))),
    vscode.commands.registerCommand('harness.showLog', () => log.show()),
  );

  void c.init();
}

// The controller is in context.subscriptions, so VS Code disposes it (and stops running agents).
export function deactivate(): void {
  controller = undefined;
}
