import * as vscode from 'vscode';
import type { Conversation } from '../core/types';

interface IndexEntry {
  id: string;
  title: string;
  updatedAt: number;
}

const INDEX_KEY = 'harness.conversations';
const LAST_KEY = 'harness.lastConversation';
const MAX_HISTORY = 100;

/** Conversations as JSON files in the workspace storage; the index lives in workspaceState. */
export class ConversationStore {
  constructor(private readonly context: vscode.ExtensionContext) {}

  private get dir(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.storageUri ?? this.context.globalStorageUri, 'conversations');
  }

  list(): IndexEntry[] {
    return this.context.workspaceState.get<IndexEntry[]>(INDEX_KEY, []);
  }

  lastId(): string | undefined {
    return this.context.workspaceState.get<string>(LAST_KEY);
  }

  async load(id: string): Promise<Conversation | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, `${id}.json`));
      return JSON.parse(Buffer.from(bytes).toString('utf8')) as Conversation;
    } catch {
      return undefined;
    }
  }

  async save(conv: Conversation): Promise<void> {
    if (!conv.messages.length) return;
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, `${conv.id}.json`), Buffer.from(JSON.stringify(conv)));
    const entries = this.list().filter((e) => e.id !== conv.id);
    entries.unshift({ id: conv.id, title: conv.title, updatedAt: conv.updatedAt });
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    const dropped = entries.splice(MAX_HISTORY);
    await this.context.workspaceState.update(INDEX_KEY, entries);
    await this.context.workspaceState.update(LAST_KEY, conv.id);
    for (const e of dropped) await this.remove(e.id, false);
  }

  async setLast(id: string | undefined): Promise<void> {
    await this.context.workspaceState.update(LAST_KEY, id);
  }

  async remove(id: string, updateIndex = true): Promise<void> {
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, `${id}.json`)).then(undefined, () => {});
    if (updateIndex) {
      await this.context.workspaceState.update(
        INDEX_KEY,
        this.list().filter((e) => e.id !== id),
      );
    }
  }
}
