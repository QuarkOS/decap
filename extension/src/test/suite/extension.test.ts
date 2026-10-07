import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { SetupGap } from "../../runtime";

interface Api {
  capturePrompt: (name: string) => { message: string; action: string };
  pythonMissingText: () => string;
  assess: (input: {
    pythonFound: boolean;
    runtimeReady: boolean;
    inRepo: boolean;
    hookReady: boolean;
  }) => SetupGap;
  statusText: () => string;
  gap: () => SetupGap;
  showGap: (gap: SetupGap) => void;
  setup: () => Promise<void>;
  fillWhy: (folder: string) => void;
  prompts: () => { message: string; action: string }[];
  entries: () => { folder: string; name: string; note: string; before: string; after: string }[];
  lastHtml: () => string;
  standaloneHtml: () => string;
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

suite("decap extension", () => {
  test("activates and registers the commands", async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("decap.snap"));
    assert.ok(commands.includes("decap.installHook"));
    assert.ok(commands.includes("decap.openDecisions"));
    assert.ok(commands.includes("decap.setup"));
  });

  test("shows the status bar and welcome view until setup", async () => {
    const exported = await api();
    assert.ok(exported.statusText().includes("Set up decap"), exported.statusText());
    const html = exported.standaloneHtml();
    assert.ok(html.includes("Set up decap"), html);
    assert.ok(html.includes("post-commit hook"), html);
    assert.strictEqual(exported.gap() === "ready", false);
  });

  test("explains a missing Python with a download link", async () => {
    const exported = await api();
    assert.strictEqual(exported.assess({
      pythonFound: false,
      runtimeReady: false,
      inRepo: true,
      hookReady: false,
    }), "python");
    exported.showGap("python");
    const text = exported.pythonMissingText();
    assert.ok(text.includes("Python 3.11"));
    assert.ok(text.includes("https://www.python.org/downloads/"));
    assert.ok(exported.statusText().includes("Set up decap"));
    const html = exported.standaloneHtml();
    assert.ok(html.includes("https://www.python.org/downloads/"), html);
    assert.ok(html.includes("Python 3.11"), html);
    assert.ok(html.includes("Set up decap"), html);
  });

  test("setup installs the hook and a commit offers Fill in why", async function () {
    this.timeout(240000);
    const exported = await api();
    const repo = root();
    await exported.setup();
    assert.strictEqual(exported.gap(), "ready");
    assert.strictEqual(exported.statusText(), "");
    const hook = fs.readFileSync(path.join(repo, ".git", "hooks", "post-commit"), "utf8");
    assert.ok(hook.includes("# decap: begin"));
    assert.ok(hook.replace(/\\/g, "/").includes("bundled/decap.py"));
    assert.ok(hook.includes("hook || true"));
    assert.ok(!hook.includes("git+https://github.com/QuarkOS/decap.git"));
    execFileSync("git", ["add", "-A"], { cwd: repo });
    execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", "use sum"], { cwd: repo });
    await waitFor(() => exported.entries().length === 1, "a capture");
    await waitFor(
      () => exported.prompts().some((item) => item.action === "Fill in why"),
      "Fill in why",
    );
    const entry = exported.entries()[0];
    const prompt = exported.prompts().find((item) => item.message === `decap saved ${entry.name}`);
    assert.ok(prompt, exported.prompts().map((item) => item.message).join("\n"));
    assert.strictEqual(prompt.action, "Fill in why");
    assert.strictEqual(exported.capturePrompt("example").action, "Fill in why");
    assert.ok(fs.statSync(entry.before).size > 500);
    assert.ok(fs.statSync(entry.after).size > 500);
    exported.fillWhy(entry.folder);
    const html = exported.lastHtml();
    assert.ok(html.includes('alt="before"'), html);
    assert.ok(html.includes('alt="after"'), html);
    assert.ok(html.includes("autofocus"), html);
    assert.ok(html.includes("<textarea id=\"why\""), html);
  });
});
