import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { capture, captureDetailed, CaptureResult, commitFreshness, setGitPath } from "./capture";
import { ageLabel } from "./rules";
import { watchCommits } from "./git";
import { joinWhy, listDecisions, renderPage, splitWhy } from "./view";

export function capturePrompt(name: string): { message: string; action: string } {
  return { message: `decap saved ${name}`, action: "Fill in why" };
}

function oldLabel(ageMs: number): string {
  return ageMs < 60 * 60 * 1000 ? "changed less than an hour ago" : `${ageLabel(ageMs)} old`;
}

export function skipText(result: CaptureResult): string {
  const hours = result.minAgeHours ?? 12;
  switch (result.skipped) {
    case "young":
      return `the lines you changed are younger than ${hours} hours${result.oldestMs !== undefined ? ` (the oldest was ${oldLabel(result.oldestMs)})` : ""}`;
    case "added-only":
      return "it only added new lines, and decap captures changes to existing lines";
    case "captured":
      return "this change was already captured";
    case "merge":
      return "merge commits are skipped";
    case "first":
      return "the first commit has nothing to compare against";
    default:
      return "it had no text changes decap tracks";
  }
}

export async function activate(context: vscode.ExtensionContext) {
  const prompts: { message: string; action: string }[] = [];
  const notices: string[] = [];
  const statusMessages: string[] = [];
  const skips: string[] = [];
  const output = vscode.window.createOutputChannel("decap");
  const log = (line: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  log(`decap ${context.extension.packageJSON.version} active in ${workspaceRoot() ?? "a window with no folder"}`);
  const fontFile = path.join(context.extensionPath, "media", "DejaVuSansMono.ttf");
  let viewRoot: string | undefined;
  const view = new DecisionView(() => viewRoot ?? workspaceRoot(), () => updatePending());
  const announced = new Set<string>();
  const primed = new Set<string>();
  const pending: string[] = [];
  const pendingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  pendingItem.command = "decap.fillWhy";
  context.subscriptions.push(output, pendingItem);

  function prime(root: string) {
    const key = pathKey(root);
    if (primed.has(key)) {
      return;
    }
    primed.add(key);
    for (const entry of listDecisions(root)) {
      announced.add(pathKey(entry.folder));
    }
  }
  const initial = workspaceRoot();
  if (initial) {
    prime(initial);
  }

  function updatePending() {
    for (let i = pending.length - 1; i >= 0; i--) {
      const notePath = path.join(pending[i], "note.md");
      const note = fs.existsSync(notePath) ? fs.readFileSync(notePath, "utf8").replace(/\r\n/g, "\n") : "";
      if (!note || splitWhy(note).why.trim() !== "") {
        pending.splice(i, 1);
      }
    }
    if (pending.length === 0) {
      pendingItem.hide();
      return;
    }
    pendingItem.text = `$(edit) decap: fill in why${pending.length > 1 ? ` (${pending.length})` : ""}`;
    pendingItem.tooltip = "decap captured a change. Click to write down why you made it.";
    pendingItem.show();
  }

  function announce(root: string) {
    prime(root);
    for (const entry of listDecisions(root)) {
      const key = pathKey(entry.folder);
      if (announced.has(key)) {
        continue;
      }
      announced.add(key);
      const folder = entry.folder;
      const prompt = capturePrompt(entry.name);
      prompts.push(prompt);
      pending.unshift(folder);
      if (process.env.DECAP_TEST === "1") {
        continue;
      }
      void vscode.window.showInformationMessage(prompt.message, prompt.action).then((choice) => {
        if (choice === prompt.action) {
          void fillWhy(folder);
        }
      });
    }
    viewRoot = root;
    view.refresh();
    updatePending();
  }

  async function onCommit(root: string) {
    const fresh = commitFreshness(root);
    if (!fresh.fresh) {
      log(`skipped ${root}: ${fresh.detail}`);
      return;
    }
    prime(root);
    const result = await captureDetailed({ start: root, source: "commit", fontFile });
    const sha = result.commit.slice(0, 7);
    if (result.written.length > 0) {
      log(`commit ${sha} in ${root}: captured ${result.written.map((item) => path.basename(item)).join(", ")}`);
      announce(root);
      return;
    }
    const reason = skipText(result);
    log(`commit ${sha} in ${root}: nothing captured, because ${reason}`);
    const status = `decap: nothing captured, ${reason}`;
    statusMessages.push(status);
    if (result.skipped) {
      skips.push(result.skipped);
    }
    context.subscriptions.push(vscode.window.setStatusBarMessage(`$(info) ${status}`, 20000));
    if (result.skipped !== "young" || context.globalState.get<boolean>("decap.youngNoticeShown")) {
      return;
    }
    await context.globalState.update("decap.youngNoticeShown", true);
    const hours = result.minAgeHours ?? 12;
    const notice = `decap captured nothing from commit ${sha}: ${reason}. decap only records changes to lines that are at least ${hours} hours old. To capture younger lines in this repository, run: git config decap.minAge 0`;
    notices.push(notice);
    if (process.env.DECAP_TEST === "1") {
      return;
    }
    void vscode.window.showInformationMessage(notice, "Show log").then((choice) => {
      if (choice === "Show log") {
        output.show(true);
      }
    });
  }

  const watching = watchCommits(context, onCommit, {
    log,
    onRepo: (root) => {
      prime(root);
      if (!viewRoot) {
        viewRoot = root;
        view.refresh();
      }
    },
    onGitPath: (gitPath) => setGitPath(gitPath),
  });
  watching.whenReady.catch((err: unknown) => log(`git watch failed: ${err instanceof Error ? err.message : String(err)}`));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("decap.decisions", view),
    vscode.commands.registerCommand("decap.snap", () => snap()),
    vscode.commands.registerCommand("decap.showLog", () => output.show(true)),
    vscode.commands.registerCommand("decap.fillWhy", () => (pending[0] ? fillWhy(pending[0]) : undefined)),
    vscode.commands.registerCommand("decap.openDecisions", async () => {
      await vscode.commands.executeCommand("decap.decisions.focus");
      view.refresh();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (path.basename(doc.uri.fsPath) === "note.md") {
        view.refresh();
        updatePending();
      }
    }),
  );

  async function fillWhy(folder: string) {
    viewRoot = path.dirname(path.dirname(folder));
    view.select(folder);
    const notePath = path.join(folder, "note.md");
    if (process.env.DECAP_TEST === "1" || !fs.existsSync(notePath)) {
      view.fillWhy(folder);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(notePath);
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    const end = doc.lineAt(doc.lineCount - 1).range.end;
    editor.selection = new vscode.Selection(end, end);
    editor.revealRange(new vscode.Range(end, end));
  }

  async function snap() {
    const root = workspaceRoot();
    if (!root) {
      void vscode.window.showWarningMessage("Open a folder before running decap: Snap.");
      return;
    }
    let written: string[];
    try {
      written = await capture({ start: viewRoot ?? root, source: "worktree", fontFile });
    } catch (err) {
      const message = err instanceof Error ? err.message.trim() : "";
      log(`snap failed: ${message}`);
      void vscode.window.showErrorMessage(message ? `decap snap failed. ${message}` : "decap snap failed.");
      return;
    }
    if (written.length === 0) {
      context.subscriptions.push(vscode.window.setStatusBarMessage("$(info) decap: nothing to snap, no changed lines since the last commit", 10000));
      return;
    }
    announce(path.dirname(path.dirname(written[0])));
  }

  return {
    capturePrompt,
    whenWatching: () => watching.whenReady,
    refreshGit: () => watching.refresh(),
    prompts: () => prompts,
    notices: () => notices,
    statusMessages: () => statusMessages,
    skips: () => skips,
    pendingText: () => (pendingItem.text && pending.length ? pendingItem.text : ""),
    entries: () => view.entries(),
    lastHtml: () => view.lastHtml,
    standaloneHtml: () => view.standaloneHtml(),
    fillWhy: (folder: string) => { void fillWhy(folder); },
    refresh: () => view.refresh(),
  };
}

export function deactivate() {
  return undefined;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

class DecisionView implements vscode.WebviewViewProvider {
  lastHtml = "";
  private view?: vscode.WebviewView;
  private selected?: string;
  private wantFocus = false;

  constructor(private rootOf: () => string | undefined, private onSaved: () => void = () => undefined) {}

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    const root = this.rootOf();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots(root),
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
      this.view.webview.options = { enableScripts: true, localResourceRoots: resourceRoots(this.rootOf()) };
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
    this.onSaved();
  }
}

function resourceRoots(root: string | undefined): vscode.Uri[] {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
  if (root) {
    roots.push(vscode.Uri.file(root));
  }
  return roots;
}
