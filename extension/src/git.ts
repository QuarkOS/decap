import * as path from "path";
import * as vscode from "vscode";

interface GitHead {
  commit?: string;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD: GitHead | undefined;
    onDidChange: (listener: () => void) => vscode.Disposable;
  };
  status(): Promise<void>;
}

interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: (listener: (repo: GitRepository) => void) => vscode.Disposable;
}

interface GitExtension {
  enabled: boolean;
  getAPI(version: 1): GitAPI;
}

export interface GitWatch {
  whenReady: Promise<void>;
  refresh(): Promise<void>;
}

function same(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function watchCommits(
  context: vscode.ExtensionContext,
  onCommit: (root: string) => Promise<void>,
): GitWatch {
  const repos = new Set<GitRepository>();
  let chain = Promise.resolve();
  const enqueue = (root: string) => {
    chain = chain.then(() => onCommit(root)).catch((err: unknown) => {
      const message = err instanceof Error ? err.message.trim() : "";
      void vscode.window.showErrorMessage(message ? `decap could not capture this commit. ${message}` : "decap could not capture this commit.");
    });
  };
  const track = (repo: GitRepository) => {
    if (repos.has(repo)) {
      return;
    }
    repos.add(repo);
    let seen = repo.state.HEAD?.commit;
    context.subscriptions.push(repo.state.onDidChange(() => {
      const next = repo.state.HEAD?.commit;
      if (!next || next === seen) {
        return;
      }
      seen = next;
      enqueue(repo.rootUri.fsPath);
    }));
  };
  const whenReady = (async () => {
    const ext = vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!ext) {
      throw new Error("The built-in Git extension is unavailable.");
    }
    const exported = ext.isActive ? ext.exports : await ext.activate();
    if (!exported.enabled) {
      throw new Error("Git is disabled in this editor.");
    }
    const api = exported.getAPI(1);
    for (const repo of api.repositories) {
      track(repo);
    }
    context.subscriptions.push(api.onDidOpenRepository((repo) => track(repo)));
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!folder) {
      return;
    }
    const opened = () => api.repositories.some((repo) => same(repo.rootUri.fsPath, folder));
    if (opened()) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve();
      }, 15000);
      const sub = api.onDidOpenRepository(() => {
        if (opened()) {
          clearTimeout(timer);
          sub.dispose();
          resolve();
        }
      });
    });
  })();
  return {
    whenReady,
    refresh: async () => {
      await whenReady;
      await Promise.all([...repos].map((repo) => repo.status()));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await chain;
    },
  };
}
