import * as assert from "assert";
import { execFileSync } from "child_process";
import { createReadStream } from "fs";
import * as fs from "fs";
import * as path from "path";
import { decodePNGFromStream } from "pureimage";
import * as vscode from "vscode";
import { changeKey, TextHunk } from "../../rules";

const APP_KEY = "2dd27812f1692903";
const OLD_KEY = "9d1dde00241324bf";

interface Api {
  capturePrompt: (name: string) => { message: string; action: string };
  whenWatching: () => Promise<void>;
  refreshGit: () => Promise<void>;
  prompts: () => { message: string; action: string }[];
  entries: () => { folder: string; name: string; note: string; before: string; after: string }[];
  lastHtml: () => string;
  standaloneHtml: () => string;
  fillWhy: (folder: string) => void;
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

async function waitFor(read: () => boolean, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 20000) {
    if (read()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
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
    assert.ok(entry.note.includes("Why:\n"), entry.note);
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
    assert.ok(html.includes("autofocus"), html);
    const out = process.env.DECAP_E2E_OUT;
    if (out) {
      fs.mkdirSync(out, { recursive: true });
      fs.copyFileSync(entry.before, path.join(out, "before.png"));
      fs.copyFileSync(entry.after, path.join(out, "after.png"));
    }
  });

  test("a fresh line commit writes nothing", async () => {
    const exported = await api();
    const before = exported.entries().length;
    fs.writeFileSync(path.join(root(), "src", "app.py"), "def total(xs):\n    return sum(xs) + 1\n");
    git(["add", "-A"]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "young"]);
    await exported.refreshGit();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.strictEqual(exported.entries().length, before);
  });

  test("snap captures the working tree", async () => {
    const exported = await api();
    const before = exported.entries().length;
    fs.writeFileSync(path.join(root(), "src", "app.py"), "def total(xs):\n    return sum(xs) + 2\n");
    await vscode.commands.executeCommand("decap.snap");
    await waitFor(() => exported.entries().length === before + 1, "a snap");
    const entry = exported.entries()[0];
    assert.ok(entry.note.includes("commit: uncommitted"), entry.note);
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
