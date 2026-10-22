// Minimal stand-in for the `vscode` module: enough of the API for the extension host code to run in Node tests.
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const pkg = require('../../package.json');

export class Uri {
  private constructor(readonly fsPath: string) {}
  static file(p: string) {
    return new Uri(p);
  }
  static parse(s: string) {
    return new Uri(s.replace(/^file:\/\//, ''));
  }
  static joinPath(base: Uri, ...parts: string[]) {
    return new Uri(join(base.fsPath, ...parts));
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

export class Disposable {
  constructor(private readonly fn: () => void) {}
  dispose() {
    this.fn();
  }
}

export class Range {
  constructor(
    readonly startLine: number,
    readonly startCol: number,
    readonly endLine: number,
    readonly endCol: number,
  ) {}
}

export enum StatusBarAlignment {
  Left = 1,
  Right = 2,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
  One = 1,
}

/** Test hooks: settings overrides, the registered view provider, opened documents, warnings. */
export const mock = {
  settings: {} as Record<string, unknown>,
  workspaceDir: '',
  trusted: true,
  viewProviders: new Map<string, any>(),
  commands: new Map<string, (...a: any[]) => any>(),
  opened: [] as { path: string; selection?: Range }[],
  warnings: [] as string[],
  clipboard: '',
};

const defaults: Record<string, unknown> = Object.fromEntries(
  Object.entries(pkg.contributes.configuration.properties as Record<string, { default: unknown }>).map(([k, v]) => [k, v.default]),
);

export const workspace = {
  get workspaceFolders() {
    return mock.workspaceDir ? [{ uri: Uri.file(mock.workspaceDir), name: 'test-project', index: 0 }] : undefined;
  },
  getConfiguration(section: string) {
    const key = (k: string) => `${section}.${k}`;
    return {
      get<T>(k: string, def?: T): T {
        const full = key(k);
        return (full in mock.settings ? mock.settings[full] : full in defaults ? defaults[full] : def) as T;
      },
      inspect<T>(k: string) {
        const full = key(k);
        return { key: full, defaultValue: defaults[full] as T, globalValue: mock.settings[full] as T | undefined };
      },
    };
  },
  get isTrusted() {
    return mock.trusted;
  },
  onDidChangeConfiguration: () => new Disposable(() => {}),
  onDidGrantWorkspaceTrust: () => new Disposable(() => {}),
  fs: {
    readFile: async (u: Uri) => new Uint8Array(await readFile(u.fsPath)),
    writeFile: async (u: Uri, data: Uint8Array) => {
      await mkdir(dirname(u.fsPath), { recursive: true });
      await writeFile(u.fsPath, data);
    },
    createDirectory: async (u: Uri) => void (await mkdir(u.fsPath, { recursive: true })),
    delete: async (u: Uri) => rm(u.fsPath, { force: true, recursive: true }),
    stat: async (u: Uri) => stat(u.fsPath),
  },
  findFiles: async () => [] as Uri[],
};

const outputChannel = () => ({ info: () => {}, error: () => {}, show: () => {}, dispose: () => {} });

export const window = {
  createOutputChannel: outputChannel,
  createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show: () => {}, dispose: () => {} }),
  registerWebviewViewProvider(id: string, provider: any) {
    mock.viewProviders.set(id, provider);
    return new Disposable(() => mock.viewProviders.delete(id));
  },
  createWebviewPanel: () => {
    throw new Error('not mocked');
  },
  showTextDocument: async (uri: Uri, opts?: { selection?: Range }) => {
    mock.opened.push({ path: uri.fsPath, selection: opts?.selection });
  },
  showWarningMessage: async (m: string) => {
    mock.warnings.push(m);
  },
};

export const commands = {
  registerCommand(id: string, fn: (...a: any[]) => any) {
    mock.commands.set(id, fn);
    return new Disposable(() => mock.commands.delete(id));
  },
  executeCommand: async () => {},
};

export const env = {
  language: 'en',
  clipboard: {
    writeText: async (t: string) => {
      mock.clipboard = t;
    },
  },
  openExternal: async () => true,
};

export function memento() {
  const data = new Map<string, unknown>();
  return {
    get: <T>(k: string, d?: T) => (data.has(k) ? (data.get(k) as T) : d),
    update: async (k: string, v: unknown) => void data.set(k, v),
    keys: () => [...data.keys()],
  };
}

/** A fake webview that records what the extension posts and lets the test send messages in. */
export function fakeWebview() {
  let handler: (m: any) => unknown = () => {};
  const posted: any[] = [];
  return {
    options: {},
    html: '',
    cspSource: 'vscode-resource:',
    asWebviewUri: (u: Uri) => u,
    // Real webviews serialise on post; keeping live references would let later mutations leak into old snapshots.
    postMessage: async (m: any) => {
      posted.push(JSON.parse(JSON.stringify(m)));
      return true;
    },
    onDidReceiveMessage: (fn: (m: any) => unknown) => {
      handler = fn;
      return new Disposable(() => {});
    },
    send: (m: any) => handler(m),
    posted,
  };
}
