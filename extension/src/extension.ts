import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import * as vscode from "vscode";
import { explainHook, explainInstall, hookInstalled, installTarget, offer, Tools } from "./setup";
import { joinWhy, listDecisions, renderPage, splitWhy } from "./view";

const exec = promisify(execFile);

export async function activate(context: vscode.ExtensionContext) {
  const prompts: string[] = [];
  const view = new DecisionView(() => workspaceRoot());
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("decap.decisions", view),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("decap.snap", () => snap(view)),
    vscode.commands.registerCommand("decap.installHook", () => installHook(workspaceRoot())),
    vscode.commands.registerCommand("decap.installCli", () => installCli(context.extensionPath)),
    vscode.commands.registerCommand("decap.openDecisions", async () => {
      await vscode.commands.executeCommand("decap.decisions.focus");
      view.refresh();
    }),
  );
  const watcher = vscode.workspace.createFileSystemWatcher("**/.decisions/**/note.md");
  watcher.onDidCreate((uri) => {
    view.refresh();
    const name = path.basename(path.dirname(uri.fsPath));
    void vscode.window.showInformationMessage(`decap saved ${name}`, "Open").then((choice) => {
      if (choice === "Open") {
        view.select(path.dirname(uri.fsPath));
        void vscode.commands.executeCommand("decap.openDecisions");
      }
    });
  });
  context.subscriptions.push(watcher);
  if (process.env.DECAP_TEST !== "1") {
    void offerSetup(context.extensionPath);
  }
  return {
    prompts,
    explainInstall,
    explainHook,
    offer,
    entries: () => view.entries(),
    lastHtml: () => view.lastHtml,
    standaloneHtml: () => view.standaloneHtml(),
    refresh: () => view.refresh(),
  };
}

export function deactivate() {
  return undefined;
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

async function detectTools(): Promise<Tools> {
  return {
    decap: await onPath("decap"),
    pipx: await onPath("pipx"),
    pip: await onPath("pip"),
  };
}

function onPath(name: string): Promise<boolean> {
  const cmd = process.platform === "win32" ? "where" : "which";
  return exec(cmd, [name]).then(() => true, () => false);
}

async function offerSetup(extensionPath: string) {
  const root = workspaceRoot();
  if (!root) {
    return;
  }
  const tools = await detectTools();
  await offer({
    tools,
    root,
    extensionPath,
    ask: (text, buttons) => vscode.window.showInformationMessage(text, ...buttons),
    run: (command, cwd) => runCommand(command, cwd, command[0] === "decap" ? "Installing the decap hook" : "Installing decap"),
  });
}

async function installCli(extensionPath: string) {
  const root = workspaceRoot();
  const tools = await detectTools();
  const plan = explainInstall(
    { ...tools, decap: false },
    installTarget(extensionPath, root),
  );
  if (!plan.command.length) {
    void vscode.window.showErrorMessage(plan.text);
    return;
  }
  const choice = await vscode.window.showInformationMessage(plan.text, "Install", "Not now");
  if (choice === "Install") {
    await runCommand(plan.command, root || process.cwd(), "Installing decap");
  }
}

async function installHook(root: string | undefined) {
  if (!root) {
    void vscode.window.showWarningMessage("Open a folder before installing the decap hook.");
    return;
  }
  if (!fs.existsSync(path.join(root, ".git"))) {
    void vscode.window.showWarningMessage("This folder is not a git repository.");
    return;
  }
  if (hookInstalled(root)) {
    void vscode.window.showInformationMessage("The decap hook is already installed.");
    return;
  }
  await runCommand(["decap", "install"], root, "Installing the decap hook");
}

async function snap(view: DecisionView) {
  const root = workspaceRoot();
  if (!root) {
    void vscode.window.showWarningMessage("Open a folder before running decap: Snap.");
    return;
  }
  try {
    await exec("decap", ["snap"], { cwd: root });
  } catch (err) {
    void vscode.window.showErrorMessage(plain("decap snap failed", err));
    return;
  }
  view.refresh();
}

async function runCommand(command: string[], cwd: string, title: string): Promise<boolean> {
  let ok = true;
  await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title,
  }, async () => {
    try {
      await exec(command[0], command.slice(1), { cwd });
    } catch (err) {
      ok = false;
      void vscode.window.showErrorMessage(plain(`${title} failed`, err));
    }
  });
  return ok;
}

function plain(title: string, err: unknown): string {
  const stderr = typeof err === "object" && err && "stderr" in err ? String((err as { stderr?: string }).stderr || "") : "";
  const detail = stderr.trim();
  if (detail) {
    return `${title}. ${detail}`;
  }
  const message = err instanceof Error ? err.message.trim() : "";
  return message ? `${title}. ${message}` : `${title}.`;
}

class DecisionView implements vscode.WebviewViewProvider {
  lastHtml = "";
  private view?: vscode.WebviewView;
  private selected?: string;

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

  refresh() {
    const entries = this.entries();
    const entry = entries.find((item) => item.folder === this.selected) || entries[0];
    this.selected = entry?.folder;
    this.lastHtml = renderPage(entry, entries, (file) => this.src(file));
    if (this.view) {
      this.view.webview.html = this.lastHtml;
    }
  }

  standaloneHtml(): string {
    const entries = this.entries();
    const entry = entries.find((item) => item.folder === this.selected) || entries[0];
    return renderPage(entry, entries, (file) => path.basename(file));
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
