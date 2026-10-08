import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { capture, captureDetailed, CaptureResult, commitDescendsFrom, commitFreshness, commitsSince, readSeenCommit, resolveCommit, setGitPath, writeSeenCommit } from "./capture";
import { watchCommits } from "./git";
import { applyWhy, fileMeta, fileTitle, parseNote } from "./note";
import { renderSaved, renderWhyPanel } from "./panel";
import { ageLabel } from "./rules";
import { decisionRow, listDecisions, renderPage, rowMatches } from "./view";

export function capturePrompt(name: string): { message: string; action: string } {
  return { message: `decap saved ${name}`, action: "Fill in why" };
}

export function youngNotice(ageMs: number): string {
  if (ageMs < 60 * 1000) {
    return "Nothing captured: these lines are less than a minute old";
  }
  return `Nothing captured: these lines are only ${ageLabel(ageMs)} old`;
}

export function reviewEmpty(result: CaptureResult): string {
  switch (result.skipped) {
    case "added-only":
      return "Nothing to review: this commit only added new lines.";
    case "merge":
      return "Nothing to review: merge commits are skipped.";
    case "first":
      return "Nothing to review: the first commit has nothing to compare against.";
    case "captured":
      return "Nothing to review: this change was already captured.";
    default:
      return "Nothing to review: this commit has no text changes decap tracks.";
  }
}

export function skipText(result: CaptureResult): string {
  switch (result.skipped) {
    case "young":
      return youngNotice(result.oldestMs ?? 0);
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
  const reviews: { message: string; action: string }[] = [];
  const reviewNotes: string[] = [];
  const statusMessages: string[] = [];
  const skips: string[] = [];
  let lastYoungRoot: string | undefined;
  const output = vscode.window.createOutputChannel("decap");
  const log = (line: string) => output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  log(`decap ${context.extension.packageJSON.version} active in ${workspaceRoot() ?? "a window with no folder"}`);
  const fontFile = path.join(context.extensionPath, "media", "DejaVuSansMono.ttf");
  let viewRoot: string | undefined;
  const view = new DecisionView(() => viewRoot ?? workspaceRoot(), (folder, text) => writeWhy(folder, text, "sidebar"));
  const announced = new Set<string>();
  const primed = new Set<string>();
  const pending: string[] = [];
  const pendingItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  pendingItem.command = "decap.fillWhy";
  const youngItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 40);
  youngItem.command = "decap.reviewAnyway";
  youngItem.tooltip = "Review anyway";
  let youngTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(output, pendingItem, youngItem);

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
      if (!note || parseNote(note).why.trim() !== "") {
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

  function remember(root: string, folders: string[]) {
    prime(root);
    for (const folder of folders) {
      const key = pathKey(folder);
      if (announced.has(key)) {
        continue;
      }
      announced.add(key);
      pending.unshift(folder);
    }
    viewRoot = root;
    view.refresh();
    updatePending();
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

  async function reviewCommit(start: string | undefined): Promise<void> {
    if (!start) {
      const message = "Open a folder before reviewing a commit.";
      reviewNotes.push(message);
      if (process.env.DECAP_TEST !== "1") {
        void vscode.window.showWarningMessage(message);
      }
      return;
    }
    let result: CaptureResult;
    try {
      result = await captureDetailed({ start, source: "commit", fontFile, anyAge: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message.trim() : "";
      const message = detail ? `decap review failed. ${detail}` : "decap review failed.";
      log(message);
      reviewNotes.push(message);
      if (process.env.DECAP_TEST !== "1") {
        void vscode.window.showErrorMessage(message);
      }
      return;
    }
    if (result.written.length > 0) {
      log(`reviewed ${result.commit.slice(0, 7)} in ${result.root}: ${result.written.map((item) => path.basename(item)).join(", ")}`);
      youngItem.hide();
      remember(result.root, result.written);
      fillWhy(result.written[0]);
      return;
    }
    if (result.skipped === "captured" && result.existing && result.existing.length > 0) {
      const message = "Opened the form for this capture.";
      reviewNotes.push(message);
      log(message);
      youngItem.hide();
      fillWhy(result.existing[0]);
      if (process.env.DECAP_TEST !== "1") {
        void vscode.window.setStatusBarMessage(`$(info) ${message}`, 20000);
      }
      return;
    }
    const message = reviewEmpty(result);
    reviewNotes.push(message);
    log(message);
    if (process.env.DECAP_TEST !== "1") {
      void vscode.window.showInformationMessage(message);
    }
  }

  function present(root: string, result: CaptureResult) {
    const sha = result.commit.slice(0, 7);
    if (result.written.length > 0) {
      log(`commit ${sha} in ${root}: captured ${result.written.map((item) => path.basename(item)).join(", ")}`);
      announce(root);
      return;
    }
    const reason = skipText(result);
    const status = result.skipped === "young" ? reason : `decap: nothing captured, ${reason}`;
    log(result.skipped === "young" ? `commit ${sha} in ${root}: ${status}` : `commit ${sha} in ${root}: nothing captured, because ${reason}`);
    statusMessages.push(status);
    if (result.skipped) {
      skips.push(result.skipped);
    }
    if (result.skipped === "young") {
      lastYoungRoot = root;
      youngItem.text = `$(info) ${status}`;
      youngItem.show();
      if (youngTimer) {
        clearTimeout(youngTimer);
      }
      youngTimer = setTimeout(() => youngItem.hide(), 20000);
      const review = {
        message: status,
        action: "Review anyway",
      };
      reviews.push(review);
      if (process.env.DECAP_TEST !== "1") {
        void vscode.window.showInformationMessage(review.message, review.action).then((choice) => {
          if (choice === review.action) {
            void reviewCommit(root);
          }
        });
      }
      return;
    }
    youngItem.hide();
    context.subscriptions.push(vscode.window.setStatusBarMessage(`$(info) ${status}`, 20000));
  }

  async function onCommit(root: string, observed: string) {
    const head = resolveCommit(root, observed);
    const prior = readSeenCommit(root);
    if (prior && prior.commit === head) {
      return;
    }
    if (prior && commitDescendsFrom(root, prior.commit, head)) {
      const missed = commitsSince(root, prior.commit, head);
      prime(root);
      for (const sha of missed) {
        present(root, await captureDetailed({ start: root, source: "commit", fontFile, rev: sha }));
      }
      writeSeenCommit(root, { commit: head });
      return;
    }
    const fresh = commitFreshness(root, new Date(), head);
    if (!fresh.fresh) {
      if (!prior) {
        log(`existing history in ${root} was left as it is`);
      } else {
        log(`skipped ${root}: ${fresh.detail}`);
      }
      writeSeenCommit(root, { commit: head });
      return;
    }
    prime(root);
    present(root, await captureDetailed({ start: root, source: "commit", fontFile, rev: head }));
    writeSeenCommit(root, { commit: head });
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
    vscode.commands.registerCommand("decap.reviewAnyway", () => reviewCommit(lastYoungRoot ?? workspaceRoot())),
    vscode.commands.registerCommand("decap.reviewLast", () => reviewCommit(workspaceRoot())),
    vscode.commands.registerCommand("decap.openNote", (uri: vscode.Uri) => openNoteAsText(uri)),
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

  function showWhy(folder: string, banner?: string) {
    view.select(folder);
    const notePath = path.join(folder, "note.md");
    if (!fs.existsSync(notePath)) {
      return;
    }
    const parsed = parseNote(fs.readFileSync(notePath, "utf8"));
    const title = fileTitle(parsed);
    if (!whyPanel) {
      whyPanel = vscode.window.createWebviewPanel("decap.why", title, vscode.ViewColumn.Active, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: resourceRoots(folder),
      });
      context.subscriptions.push(whyPanel);
      whyPanel.onDidDispose(() => {
        whyPanel = undefined;
        whyFolder = undefined;
        if (whyClose) {
          clearTimeout(whyClose);
          whyClose = undefined;
        }
      });
      whyPanel.webview.onDidReceiveMessage((message: { type?: string; text?: string }) => onWhyMessage(message));
      whyPanel.onDidChangeViewState((event) => {
        if (event.webviewPanel.visible && event.webviewPanel.active) {
          void event.webviewPanel.webview.postMessage({ type: "focus" });
        }
      });
    }
    whyFolder = folder;
    whyPanel.title = title;
    whyPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: resourceRoots(folder),
    };
    const html = renderWhyPanel({
      title,
      meta: fileMeta(parsed),
      beforeSrc: whyPanel.webview.asWebviewUri(vscode.Uri.file(path.join(folder, "before.png"))).toString(),
      afterSrc: whyPanel.webview.asWebviewUri(vscode.Uri.file(path.join(folder, "after.png"))).toString(),
      why: parsed.why,
      banner,
      cspSource: whyPanel.webview.cspSource,
    });
    whyHtml = html;
    whyPanel.webview.html = html;
    whyPanel.reveal(vscode.ViewColumn.Active);
    void whyPanel.webview.postMessage({ type: "focus" });
  }

  function onWhyMessage(message: { type?: string; text?: string }) {
    if (!whyFolder || !whyPanel) {
      return;
    }
    if (message.type === "dismiss") {
      whyPanel.dispose();
      return;
    }
    if (message.type !== "save") {
      return;
    }
    const folder = whyFolder;
    writeWhy(folder, message.text || "", "panel");
    if (pending.length === 0) {
      const html = renderSaved(whyPanel.webview.cspSource);
      whyHtml = html;
      whyPanel.webview.html = html;
      if (process.env.DECAP_TEST === "1") {
        return;
      }
      if (whyClose) {
        clearTimeout(whyClose);
      }
      const closing = whyPanel;
      whyClose = setTimeout(() => closing.dispose(), 700);
      return;
    }
    showWhy(pending[0], `Saved. ${pending.length} more to fill in.`);
  }

  function fillWhy(folder: string) {
    viewRoot = path.dirname(path.dirname(folder));
    showWhy(folder);
  }

  function writeWhy(folder: string, text: string, source: "panel" | "sidebar") {
    const notePath = path.join(folder, "note.md");
    if (!fs.existsSync(notePath)) {
      return;
    }
    const note = fs.readFileSync(notePath, "utf8");
    fs.writeFileSync(notePath, applyWhy(note, text), "utf8");
    view.refresh();
    updatePending();
    if (source === "sidebar" && whyPanel && whyFolder === folder) {
      showWhy(folder);
    }
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
    reviews: () => reviews,
    reviewNotes: () => reviewNotes,
    reviewAnyway: () => reviewCommit(lastYoungRoot ?? workspaceRoot()),
    statusMessages: () => statusMessages,
    skips: () => skips,
    pendingText: () => (pendingItem.text && pending.length ? pendingItem.text : ""),
    entries: () => view.entries(),
    lastHtml: () => view.lastHtml,
    standaloneHtml: () => view.standaloneHtml(),
    fillWhy: (folder: string) => fillWhy(folder),
    panelHtml: () => whyHtml,
    panelMessage: (message: { type?: string; text?: string }) => onWhyMessage(message),
    openNote: (notePath: string) => openNoteAsText(vscode.Uri.file(notePath)),
    refresh: () => view.refresh(),
    search: (text: string) => view.search(text),
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
  private query = "";
  private focusSearch = false;

  constructor(private rootOf: () => string | undefined, private onWhy: (folder: string, text: string) => void = () => undefined) {}

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
      if (message.type === "search") {
        this.search(message.text || "");
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

  search(text: string) {
    this.query = text;
    this.focusSearch = text.trim() !== "";
    this.wantFocus = false;
    this.refresh();
  }

  refresh() {
    const focus = this.wantFocus;
    const shown = this.shown();
    this.selected = shown.entry?.folder;
    this.lastHtml = renderPage(shown.entry, shown.visible, (file) => this.src(file), focus, this.query, this.focusSearch, shown.total);
    if (this.view) {
      this.view.webview.options = { enableScripts: true, localResourceRoots: resourceRoots(this.rootOf()) };
      this.view.webview.html = this.lastHtml;
      this.wantFocus = false;
    }
  }

  standaloneHtml(): string {
    const shown = this.shown();
    return renderPage(shown.entry, shown.visible, (file) => path.basename(file), this.wantFocus, this.query, this.focusSearch, shown.total);
  }

  private shown() {
    const entries = this.entries();
    const visible = entries.filter((item) => rowMatches(decisionRow(item), this.query));
    const entry = visible.find((item) => item.folder === this.selected) || visible[0];
    return { visible, entry, total: entries.length };
  }

  private src(file: string): string {
    if (!this.view) {
      return path.basename(file);
    }
    return this.view.webview.asWebviewUri(vscode.Uri.file(file)).toString();
  }

  private saveWhy(folder: string, text: string) {
    this.onWhy(folder, text);
  }
}

let whyPanel: vscode.WebviewPanel | undefined;
let whyFolder: string | undefined;
let whyHtml = "";
let whyClose: ReturnType<typeof setTimeout> | undefined;

async function openNoteAsText(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.commands.executeCommand("vscode.openWith", uri, "default", { preview: false });
  } catch {
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
  }
}

function resourceRoots(root: string | undefined): vscode.Uri[] {
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri);
  if (root) {
    roots.push(vscode.Uri.file(root));
  }
  return roots;
}
