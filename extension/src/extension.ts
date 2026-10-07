import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  PYTHON_DOWNLOAD,
  Runtime,
  SetupGap,
  assess,
  capturePrompt,
  ensureRuntime,
  findPython,
  hookReady,
  installHook,
  isGitRepo,
  pythonMissingText,
  runDecap,
  statusLabel,
  venvPython,
} from "./runtime";
import { listDecisions, renderPage, renderWelcome, splitWhy, joinWhy } from "./view";

export async function activate(context: vscode.ExtensionContext) {
  const prompts: { message: string; action: string }[] = [];
  const storage = context.globalStorageUri.fsPath;
  const script = path.join(context.extensionPath, "bundled", "decap.py");
  const view = new DecisionView(() => workspaceRoot());
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.command = "decap.setup";
  let statusVisible = false;
  let gap: SetupGap = "runtime";
  let runtime: Runtime | undefined;

  function bundledRuntime(): Runtime {
    return { python: venvPython(storage), script: path.resolve(script) };
  }

  function applyGap(next: SetupGap) {
    gap = next;
    view.setGap(next);
    const label = statusLabel(next);
    if (!label) {
      status.hide();
      status.text = "";
      statusVisible = false;
      return;
    }
    status.text = label;
    status.tooltip = next === "python"
      ? pythonMissingText()
      : "decap is not set up for this repository";
    status.show();
    statusVisible = true;
  }

  async function refreshSetup() {
    const python = await findPython();
    const current = bundledRuntime();
    const ready = fs.existsSync(current.python) && fs.existsSync(path.join(storage, "runtime", ".decap-ready"));
    if (ready) {
      runtime = current;
    }
    const root = workspaceRoot();
    applyGap(assess({
      pythonFound: Boolean(python),
      runtimeReady: ready && fs.existsSync(script),
      inRepo: isGitRepo(root),
      hookReady: Boolean(root && runtime && hookReady(root, runtime)),
    }));
  }

  async function setup(): Promise<void> {
    const python = await findPython();
    if (!python) {
      applyGap("python");
      const choice = await vscode.window.showErrorMessage(pythonMissingText(), "Install Python");
      if (choice === "Install Python") {
        await vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD));
      }
      return;
    }
    const root = workspaceRoot();
    if (!isGitRepo(root)) {
      applyGap("repo");
      void vscode.window.showWarningMessage("Open a git repository before setting up decap.");
      return;
    }
    try {
      await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: "Setting up decap",
      }, async (progress) => {
        runtime = await ensureRuntime({
          basePython: python,
          storage,
          script,
          onProgress: (text) => progress.report({ message: text }),
        });
        progress.report({ message: "Adding the post-commit hook" });
        await installHook(runtime, root);
      });
    } catch (err) {
      void vscode.window.showErrorMessage(plain("Setting up decap failed", err));
      return;
    }
    await refreshSetup();
    void vscode.window.showInformationMessage("decap is set up. Commits that change an old line will show up here.");
  }

  context.subscriptions.push(status);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("decap.decisions", view),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("decap.setup", () => setup()),
    vscode.commands.registerCommand("decap.snap", () => snap()),
    vscode.commands.registerCommand("decap.installHook", () => setup()),
    vscode.commands.registerCommand("decap.openDecisions", async () => {
      await vscode.commands.executeCommand("decap.decisions.focus");
      view.refresh();
    }),
  );
  view.onSetup(() => {
    void setup();
  });
  const announced = new Set<string>();
  const rootAtStart = workspaceRoot();
  if (rootAtStart) {
    for (const entry of listDecisions(rootAtStart)) {
      announced.add(entry.folder);
    }
  }
  const watcher = vscode.workspace.createFileSystemWatcher("**/.decisions/**/note.md");
  const announce = () => {
    const root = workspaceRoot();
    if (!root) {
      return;
    }
    for (const entry of listDecisions(root)) {
      if (announced.has(entry.folder)) {
        continue;
      }
      announced.add(entry.folder);
      const folder = entry.folder;
      const prompt = capturePrompt(entry.name);
      prompts.push(prompt);
      view.refresh();
      if (process.env.DECAP_TEST === "1") {
        continue;
      }
      void vscode.window.showInformationMessage(prompt.message, prompt.action).then((choice) => {
        if (choice === prompt.action) {
          fillWhy(folder);
        }
      });
    }
  };
  watcher.onDidCreate(announce);
  watcher.onDidChange(announce);
  const poll = setInterval(announce, 1000);
  context.subscriptions.push(watcher, { dispose: () => clearInterval(poll) });
  await refreshSetup();

  function fillWhy(folder: string) {
    view.fillWhy(folder);
    void vscode.commands.executeCommand("decap.decisions.focus");
  }

  async function snap() {
    const root = workspaceRoot();
    if (!isGitRepo(root)) {
      void vscode.window.showWarningMessage("Open a git repository before running decap: Snap.");
      return;
    }
    if (!runtime || gap !== "ready") {
      void vscode.window.showWarningMessage("Set up decap before snapping. The status bar stays visible until setup finishes.");
      return;
    }
    try {
      await runDecap(runtime, root, "snap");
    } catch (err) {
      void vscode.window.showErrorMessage(plain("decap snap failed", err));
      return;
    }
    view.refresh();
  }

  return {
    capturePrompt,
    pythonMissingText,
    assess,
    statusText: () => (statusVisible ? status.text : ""),
    gap: () => gap,
    showGap: (next: SetupGap) => applyGap(next),
    setup,
    fillWhy,
    prompts: () => prompts,
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

function plain(title: string, err: unknown): string {
  const message = err instanceof Error ? err.message.trim() : "";
  return message ? `${title}. ${message}` : `${title}.`;
}

class DecisionView implements vscode.WebviewViewProvider {
  lastHtml = "";
  private view?: vscode.WebviewView;
  private selected?: string;
  private gap: SetupGap = "runtime";
  private wantFocus = false;
  private forceEntry = false;
  private setupHandler: () => void = () => undefined;

  constructor(private rootOf: () => string | undefined) {}

  onSetup(handler: () => void) {
    this.setupHandler = handler;
  }

  setGap(gap: SetupGap) {
    this.gap = gap;
    if (gap !== "ready") {
      this.forceEntry = false;
    }
    this.refresh();
  }

  resolveWebviewView(webviewView: vscode.WebviewView) {
    this.view = webviewView;
    const root = this.rootOf();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: root ? [vscode.Uri.file(root)] : [],
    };
    webviewView.webview.onDidReceiveMessage((message: { type?: string; folder?: string; text?: string }) => {
      if (message.type === "setup") {
        this.setupHandler();
      }
      if (message.type === "install-python") {
        void vscode.env.openExternal(vscode.Uri.parse(PYTHON_DOWNLOAD));
      }
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
    this.forceEntry = true;
    this.refresh();
  }

  fillWhy(folder: string) {
    this.selected = folder;
    this.forceEntry = true;
    this.wantFocus = true;
    this.refresh();
  }

  refresh() {
    const focus = this.wantFocus;
    if (this.gap !== "ready" && !this.forceEntry) {
      this.lastHtml = renderWelcome(this.gap);
    } else {
      const entries = this.entries();
      const entry = entries.find((item) => item.folder === this.selected) || entries[0];
      this.selected = entry?.folder;
      this.lastHtml = renderPage(entry, entries, (file) => this.src(file), focus);
    }
    if (this.view) {
      this.view.webview.html = this.lastHtml;
      this.wantFocus = false;
    }
  }

  standaloneHtml(): string {
    if (this.gap !== "ready" && !this.forceEntry) {
      return renderWelcome(this.gap);
    }
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
