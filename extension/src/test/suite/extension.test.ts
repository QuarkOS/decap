import * as assert from "assert";
import { execFileSync } from "child_process";
import { createReadStream } from "fs";
import * as fs from "fs";
import * as path from "path";
import { decodePNGFromStream } from "pureimage";
import * as vscode from "vscode";
import { applyWhy, noteKey, parseNote, renderNote } from "../../note";
import { WHY_PLACEHOLDER } from "../../panel";
import { changeKey, TextHunk } from "../../rules";

const APP_KEY = "2dd27812f1692903";
const OLD_KEY = "9d1dde00241324bf";

interface Api {
  capturePrompt: (name: string) => { message: string; action: string };
  whenWatching: () => Promise<void>;
  refreshGit: () => Promise<void>;
  prompts: () => { message: string; action: string }[];
  notices: () => string[];
  statusMessages: () => string[];
  skips: () => string[];
  pendingText: () => string;
  entries: () => { folder: string; name: string; note: string; before: string; after: string }[];
  lastHtml: () => string;
  standaloneHtml: () => string;
  fillWhy: (folder: string) => void;
  panelHtml: () => string;
  panelMessage: (message: { type?: string; text?: string }) => void;
  openNote: (notePath: string) => Promise<void>;
  refresh: () => void;
}

async function api(): Promise<Api> {
  const ext = vscode.extensions.getExtension<Api>("quarkos.decap");
  assert.ok(ext, "decap extension is installed in the test host");
  return ext.activate();
}

function root(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  assert.ok(folder);
  return folder;
}

function git(args: string[]) {
  execFileSync("git", args, { cwd: root() });
}

async function waitFor(read: () => boolean, label: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (read()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function pendingCount(text: string): number {
  const match = text.match(/\((\d+)\)/);
  if (match) {
    return Number(match[1]);
  }
  return text.includes("fill in why") ? 1 : 0;
}

function inside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function pngHasColor(file: string, red: number, green: number, blue: number): Promise<boolean> {
  const image = await decodePNGFromStream(createReadStream(file));
  for (let i = 0; i < image.data.length; i += 4) {
    if (image.data[i] === red && image.data[i + 1] === green && image.data[i + 2] === blue) {
      return true;
    }
  }
  return false;
}

suite("decap extension", () => {
  if (process.env.DECAP_LAYOUT === "nested") {
    test("a repository one folder down is captured and Fill in why opens it", async function () {
      this.timeout(45000);
      const exported = await api();
      await exported.whenWatching();
      const inner = process.env.DECAP_INNER;
      assert.ok(inner, "DECAP_INNER is set for the nested fixture");
      const outer = root();
      assert.strictEqual(inside(inner, outer), true);
      assert.notStrictEqual(path.resolve(inner), path.resolve(outer));
      execFileSync("git", ["add", "-A"], { cwd: inner });
      execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "use sum"], { cwd: inner });
      await waitFor(
        () => exported.entries().some((entry) => entry.note.includes(`change: ${APP_KEY}`)),
        "a nested capture",
        30000,
      );
      const entry = exported.entries().find((item) => item.note.includes(`change: ${APP_KEY}`));
      assert.ok(entry);
      assert.strictEqual(inside(entry.folder, path.join(inner, ".decisions")), true);
      assert.strictEqual(fs.existsSync(path.join(outer, ".decisions")), false);
      assert.ok(exported.prompts().some((item) => item.message === `decap saved ${entry.name}`));
      exported.fillWhy(entry.folder);
      const html = exported.lastHtml();
      assert.ok(html.includes('alt="before"'), html);
      assert.ok(html.includes('alt="after"'), html);
      assert.ok(html.includes("src/app.py"), html);
      const panel = exported.panelHtml();
      assert.ok(panel.includes(WHY_PLACEHOLDER), panel);
      assert.ok(panel.includes("autofocus"), panel);
      assert.ok(panel.includes('alt="before"'), panel);
      assert.ok(!entry.note.startsWith("---"));
      assert.ok(exported.pendingText().includes("decap: fill in why"), exported.pendingText());
    });
    return;
  }

  test("reads a legacy note and writes a readable one", () => {
    const legacy = "---\ncommit: abc123\nfile: src/app.py\nlines: 10-12\nage: 2 days\nchange: abcdef\n---\n\nWhy:\nbecause\n";
    const parsed = parseNote(legacy);
    assert.strictEqual(parsed.format, "legacy");
    assert.strictEqual(parsed.why, "because");
    assert.strictEqual(noteKey(legacy), "abcdef");
    const readable = renderNote({ ...parsed, format: "readable", why: "" });
    assert.ok(readable.startsWith("# src/app.py lines 10-12\n"), readable);
    assert.strictEqual(readable.startsWith("---"), false);
    assert.ok(readable.includes("![before](before.png)"));
    assert.ok(readable.includes("![after](after.png)"));
    assert.strictEqual(noteKey(readable), "abcdef");
    const saved = applyWhy(readable, "The sum was wrong.");
    assert.ok(saved.includes("The sum was wrong."));
    assert.strictEqual(saved.split("<!--")[0].includes("change:"), false);
    const kept = applyWhy(legacy, "still legacy");
    assert.ok(kept.startsWith("---\n"));
    assert.strictEqual(parseNote(kept).why, "still legacy");
    assert.strictEqual(noteKey(kept), "abcdef");
  });

  test("the change hash matches the command line tool", () => {
    const app: TextHunk = {
      path: "src/app.py",
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: "context", text: "def total(xs):" },
        { kind: "removed", text: "    s = 0" },
        { kind: "removed", text: "    return s" },
        { kind: "added", text: "    return sum(xs)" },
      ],
    };
    const old: TextHunk = {
      path: "src/old.py",
      oldStart: 1,
      newStart: 1,
      lines: [
        { kind: "context", text: "def keep():" },
        { kind: "removed", text: "    value = 1" },
        { kind: "removed", text: "    return value" },
        { kind: "added", text: "    return 2" },
      ],
    };
    assert.strictEqual(changeKey("commit", app), APP_KEY);
    assert.strictEqual(changeKey("commit", old), OLD_KEY);
  });

  test("shows an empty state and does not ask to set up", async () => {
    const exported = await api();
    await exported.whenWatching();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("decap.snap"));
    assert.ok(commands.includes("decap.openDecisions"));
    assert.ok(commands.includes("decap.showLog"));
    assert.ok(commands.includes("decap.fillWhy"));
    assert.strictEqual(commands.includes("decap.setup"), false);
    assert.strictEqual(commands.includes("decap.installHook"), false);
    const html = exported.standaloneHtml();
    assert.ok(html.includes("at least 12 hours old"), html);
    assert.strictEqual(html.includes("Set up decap"), false);
  });

  test("a commit of an old line writes images and offers Fill in why", async function () {
    this.timeout(60000);
    const exported = await api();
    await exported.whenWatching();
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "use sum"]);
    await exported.refreshGit();
    await waitFor(() => exported.entries().length === 1, "a capture");
    const entry = exported.entries()[0];
    assert.ok(entry.note.includes(`change: ${APP_KEY}`), entry.note);
    assert.ok(entry.note.includes("file: src/app.py"), entry.note);
    assert.ok(entry.note.startsWith("# src/app.py"), entry.note);
    assert.ok(entry.note.includes("![before](before.png)"), entry.note);
    assert.ok(entry.note.includes("![after](after.png)"), entry.note);
    assert.strictEqual(entry.note.startsWith("---"), false);
    assert.ok(fs.statSync(entry.before).size > 500);
    assert.ok(fs.statSync(entry.after).size > 500);
    assert.strictEqual(await pngHasColor(entry.before, 253, 232, 232), true);
    assert.strictEqual(await pngHasColor(entry.after, 230, 244, 234), true);
    await waitFor(
      () => exported.prompts().some((item) => item.message === `decap saved ${entry.name}`),
      "Fill in why",
    );
    const prompt = exported.prompts().find((item) => item.message === `decap saved ${entry.name}`);
    assert.ok(prompt);
    assert.strictEqual(prompt.action, "Fill in why");
    exported.fillWhy(entry.folder);
    const html = exported.lastHtml();
    assert.ok(html.includes('alt="before"'), html);
    assert.ok(html.includes('alt="after"'), html);
    const panel = exported.panelHtml();
    assert.ok(panel.includes(WHY_PLACEHOLDER), panel);
    assert.ok(panel.includes("autofocus"), panel);
    assert.ok(panel.includes('alt="before"'), panel);
    assert.ok(exported.pendingText().includes("decap: fill in why"), exported.pendingText());
    const out = process.env.DECAP_E2E_OUT;
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(entry.before, path.join(out, "before.png"));
      fs.copyFileSync(entry.after, path.join(out, "after.png"));
    }
  });

  test("Fill in why saves through the panel and the status count drops", async () => {
    const exported = await api();
    const entry = exported.entries().find((item) => item.note.includes(`change: ${APP_KEY}`));
    assert.ok(entry);
    const before = pendingCount(exported.pendingText());
    assert.ok(before >= 1, exported.pendingText());
    await vscode.commands.executeCommand("decap.fillWhy");
    const panel = exported.panelHtml();
    assert.ok(panel.includes(WHY_PLACEHOLDER), panel);
    assert.ok(panel.includes("autofocus"), panel);
    exported.panelMessage({ type: "save", text: "The sum was wrong." });
    const note = fs.readFileSync(path.join(entry.folder, "note.md"), "utf8").replace(/\r\n/g, "\n");
    assert.ok(note.startsWith("# "), note);
    assert.strictEqual(note.startsWith("---"), false);
    assert.ok(note.includes("The sum was wrong."));
    assert.ok(note.includes("![before](before.png)"));
    assert.ok(note.includes("![after](after.png)"));
    assert.ok(note.includes(`change: ${APP_KEY}`));
    const visible = note.split("<!--")[0];
    assert.strictEqual(visible.includes("commit:"), false);
    assert.strictEqual(visible.includes("change:"), false);
    assert.ok(exported.lastHtml().includes("The sum was wrong."), exported.lastHtml());
    assert.strictEqual(pendingCount(exported.pendingText()), before - 1);
    assert.ok(exported.panelHtml().includes("Saved."));
  });

  test("note.md opens in the text editor", async () => {
    const exported = await api();
    const dir = path.join(root(), ".decisions", "sample");
    fs.mkdirSync(dir, { recursive: true });
    const notePath = path.join(dir, "note.md");
    fs.writeFileSync(notePath, "# src/kept.py lines 1-2\n\n<!-- decap\ncommit: abc\nfile: src/kept.py\nlines: 1-2\nage: 1 day\nchange: abc\n-->\n");
    try {
      await exported.openNote(notePath);
      const editor = vscode.window.activeTextEditor;
      assert.ok(editor, "a text editor is active");
      assert.strictEqual(samePath(editor.document.uri.fsPath, notePath), true);
      assert.ok(editor.document.getText().startsWith("# src/kept.py"));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a terminal commit is captured by the HEAD watcher", async function () {
    this.timeout(45000);
    const exported = await api();
    await exported.whenWatching();
    const before = exported.prompts().length;
    fs.writeFileSync(path.join(root(), "src", "watch.py"), "def watch():\n    return 1\n");
    git(["add", "src/watch.py"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "watch"]);
    await waitFor(() => exported.prompts().length > before, "a watcher capture", 30000);
    const entry = exported.entries().find((item) => item.note.includes("file: src/watch.py"));
    assert.ok(entry);
    assert.ok(exported.prompts().some((item) => item.message === `decap saved ${entry.name}` && item.action === "Fill in why"));
  });

  test("a fresh line commit writes nothing and explains why", async function () {
    this.timeout(30000);
    const exported = await api();
    const before = exported.entries().length;
    fs.writeFileSync(path.join(root(), "src", "app.py"), "def total(xs):\n    return sum(xs) + 1\n");
    git(["add", "src/app.py"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "young"]);
    await exported.refreshGit();
    await waitFor(() => exported.skips().includes("young"), "the young skip");
    assert.strictEqual(exported.entries().length, before);
    const status = exported.statusMessages().find((item) => item.includes("younger than 12 hours"));
    assert.ok(status, exported.statusMessages().join("\n"));
    assert.ok(status.startsWith("decap: nothing captured, "));
    const notice = exported.notices().find((item) => item.includes("git config decap.minAge 0"));
    assert.ok(notice, exported.notices().join("\n"));
    assert.ok(notice.includes("at least 12 hours old"));
    assert.strictEqual(exported.notices().length, 1);
  });

  test("a commit that only adds lines is skipped as added-only", async () => {
    const exported = await api();
    const before = exported.entries().length;
    const notices = exported.notices().length;
    fs.writeFileSync(path.join(root(), "src", "extra.py"), "def extra():\n    return 0\n    return 1\n");
    git(["add", "src/extra.py"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "add a line"]);
    await exported.refreshGit();
    await waitFor(() => exported.skips().includes("added-only"), "the added-only skip");
    assert.strictEqual(exported.entries().length, before);
    const status = exported.statusMessages().find((item) => item.includes("only added new lines"));
    assert.ok(status, exported.statusMessages().join("\n"));
    assert.ok(status.startsWith("decap: nothing captured, "));
    assert.strictEqual(exported.notices().length, notices);
  });

  test("snap captures the working tree", async () => {
    const exported = await api();
    const before = exported.entries().length;
    fs.writeFileSync(path.join(root(), "src", "app.py"), "def total(xs):\n    return sum(xs) + 2\n");
    await vscode.commands.executeCommand("decap.snap");
    await waitFor(
      () => exported.entries().some((entry) => entry.note.includes("commit: uncommitted")),
      "a snap",
    );
    const entry = exported.entries().find((item) => item.note.includes("commit: uncommitted"));
    assert.ok(entry);
    assert.strictEqual(exported.entries().length, before + 1);
    assert.ok(fs.statSync(entry.before).size > 500);
    assert.ok(fs.statSync(entry.after).size > 500);
  });

  test("a hook that already recorded the change hash does not get a second capture", async () => {
    const exported = await api();
    const before = exported.entries().length;
    const hook = path.join(root(), ".git", "hooks", "post-commit");
    fs.mkdirSync(path.dirname(hook), { recursive: true });
    fs.writeFileSync(hook, [
      "#!/bin/sh",
      "mkdir -p .decisions/from-hook",
      "printf '%s\\n' '---' 'commit: hook' 'file: src/old.py' 'lines: 1-3' 'age: 2 days' 'change: 9d1dde00241324bf' '---' '' 'Why:' > .decisions/from-hook/note.md",
      "",
    ].join("\n"), { mode: 0o755 });
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(root(), "src", "old.py"), "def keep():\n    return 2\n");
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "keep two"]);
    await exported.refreshGit();
    await waitFor(() => exported.entries().some((entry) => entry.name === "from-hook"), "hook note");
    const notes = exported.entries().filter((entry) => entry.note.includes(`change: ${OLD_KEY}`));
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(exported.entries().length, before + 1);
  });

  test("does not call Python", () => {
    const trap = process.env.DECAP_PYTHON_TRAP;
    if (!trap) {
      return;
    }
    assert.strictEqual(fs.existsSync(trap), false, fs.existsSync(trap) ? fs.readFileSync(trap, "utf8") : "");
  });
});
