import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { capture, commitIsFresh } from "./capture";
import { watchCommits } from "./git";
import { joinWhy, listDecisions, renderPage, splitWhy } from "./view";

export function capturePrompt(name: string): { message: string; action: string } {
  return { message: `decap saved ${name}`, action: "Fill in why" };
}

export async function activate(context: vscode.ExtensionContext) {
  const prompts: { message: string; action: string }[] = [];
  const fontFile = path.join(context.extensionPath, "media", "DejaVuSansMono.ttf");
  const view = new DecisionView(() => workspaceRoot());
  const announced = new Set<string>();
  const initial = workspaceRoot();
  if (initial) {
    for (const entry of listDecisions(initial)) {
      announced.add(entry.folder);
    }
  }

  function announce(root: string) {
    const showHere = samePath(root, workspaceRoot());
    for (const entry of listDecisions(root)) {
      if (announced.has(entry.folder)) {
        continue;
      }
      announced.add(entry.folder);
      const folder = entry.folder;
      const prompt = capturePrompt(entry.name);
      prompts.push(prompt);
      if (showHere) {
        view.refresh();
      }
      if (process.env.DECAP_TEST === "1") {
        continue;
      }
      void vscode.window.showInformationMessage(prompt.message, prompt.action).then((choice) => {
        if (choice === prompt.action) {
          fillWhy(folder);
        }
      });
    }
  }

  async function onCommit(root: string) {
    if (!commitIsFresh(root)) {
      return;
    }
    await capture({ start: root, source: "commit", fontFile });
    announce(root);
  }

  const watching = watchCommits(context, onCommit);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("decap.decisions", view),
    vscode.commands.registerCommand("decap.snap", () => snap()),
    vscode.commands.registerCommand("decap.openDecisions", async () => {
      await vscode.commands.executeCommand("decap.decisions.focus");
      view.refresh();
    }),
  );

  function fillWhy(folder: string) {
    view.fillWhy(folder);
    void vscode.commands.executeCommand("decap.decisions.focus");
  }

  async function snap() {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showWarningMessage("Open a folder before running decap: Snap.");
      return;
    }
    try {
      await capture({ start: root, source: "worktree", fontFile });
    } catch (err) {
      const message = err instanceof Error ? err.message.trim() : "";
      void vscode.window.showErrorMessage(message ? `decap snap failed. ${message}` : "decap snap failed.");
      return;
    }
    announce(root);
  }

  return {
    capturePrompt,
    whenWatching: () => watching.whenReady,
    refreshGit: () => watching.refresh(),
    prompts: () => prompts,
    entries: () => view.entries(),
    lastHtml: () => view.lastHtml,
    standaloneHtml: () => view.standaloneHtml(),
    fillWhy,
    refresh: () => view.refresh(),
  };
}

export function deactivate() {
  return undefined;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function samePath(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) {
    return false;
  }
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

class DecisionView implements vscode.WebviewViewProvider {
  lastHtml = "";
  private view?: vscode.WebviewView;
  private selected?: string;
  private wantFocus = false;

  constructor(private rootOf: () => string | undefined) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    const root = this.rootOf();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: root ? [vscode.Uri.file(root)] : [],
    };
    webviewView.webview.onDidReceiveMessage((message: { type?: string; folder?: string; text?: string }) => {
      if (message.type === "open" && message.folder) {
        this.select(message.folder);
      }
      if (message.type === "why" && message.folder) {
        this.saveWhy(message.folder, message.text || "");
      }
    });
    this.refresh();
  }

  entries() {
    const root = this.rootOf();
    return root ? listDecisions(root) : [];
  }

  select(folder: string) {
    this.selected = folder;
    this.refresh();
  }

  fillWhy(folder: string) {
    this.selected = folder;
    this.wantFocus = true;
    this.refresh();
  }

  refresh() {
    const focus = this.wantFocus;
    const entries = this.entries();
    const entry = entries.find((item) => item.folder === this.selected) || entries[0];
    this.selected = entry?.folder;
    this.lastHtml = renderPage(entry, entries, (file) => this.src(file), focus);
    if (this.view) {
      this.view.webview.html = this.lastHtml;
      this.wantFocus = false;
    }
  }

  standaloneHtml(): string {
    const entries = this.entries();
    const entry = entries.find((item) => item.folder === this.selected) || entries[0];
    return renderPage(entry, entries, (file) => path.basename(file), this.wantFocus);
  }

  private src(file: string): string {
    if (!this.view) {
      return path.basename(file);
    }
    return this.view.webview.asWebviewUri(vscode.Uri.file(file)).toString();
  }

  private saveWhy(folder: string, text: string) {
    const notePath = path.join(folder, "note.md");
    if (!fs.existsSync(notePath)) {
      return;
    }
    const note = fs.readFileSync(notePath, "utf8").replace(/\r\n/g, "\n");
    const { front } = splitWhy(note);
    fs.writeFileSync(notePath, joinWhy(front, text), "utf8");
  }
}
