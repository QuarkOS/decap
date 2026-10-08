import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

function prepareRepo(workspace: string): void {
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: workspace });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  const src = path.join(workspace, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "app.py"), "def total(xs):\n    s = 0\n    return s\n");
  fs.writeFileSync(path.join(src, "old.py"), "def keep():\n    value = 1\n    return value\n");
  fs.writeFileSync(path.join(src, "watch.py"), "def watch():\n    return 0\n");
  fs.writeFileSync(path.join(src, "extra.py"), "def extra():\n    return 0\n");
  execFileSync("git", ["add", "-A"], { cwd: workspace });
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  execFileSync("git", ["commit", "-m", "start"], {
    cwd: workspace,
    env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past },
  });
  fs.writeFileSync(path.join(src, "app.py"), "def total(xs):\n    return sum(xs)\n");
}

function passedEnv(): Record<string, string> {
  const env: Record<string, string> = { DECAP_TEST: "1" };
  for (const key of ["DECAP_VIEW_DIR", "DECAP_E2E_OUT", "DECAP_PYTHON_TRAP"]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

function commitAt(workspace: string, paths: string[], message: string, when: string): void {
  execFileSync("git", ["add", "--", ...paths], { cwd: workspace });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-m", message], {
    cwd: workspace,
    env: { ...process.env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
  });
}

function prepareRebaseRepo(workspace: string): void {
  prepareRepo(workspace);
  const when = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  commitAt(workspace, ["src/app.py"], "use sum", when);
  const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workspace, encoding: "utf8" }).trim();
  const branch = execFileSync("git", ["branch", "--show-current"], { cwd: workspace, encoding: "utf8" }).trim();
  execFileSync("git", ["branch", "shifted", "HEAD~1"], { cwd: workspace });
  execFileSync("git", ["checkout", "shifted"], { cwd: workspace });
  fs.writeFileSync(
    path.join(workspace, "src", "app.py"),
    "# shifted\n# so the\n# same edit\n# moves\n\ndef total(xs):\n    s = 0\n    return s\n",
  );
  commitAt(workspace, ["src/app.py"], "prefix", when);
  execFileSync("git", ["checkout", branch], { cwd: workspace });
  const dir = path.join(workspace, ".decisions", "saved-why");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "note.md"), [
    "# src/app.py lines 1-3",
    "",
    "The sum was wrong.",
    "",
    "![before](before.png)",
    "![after](after.png)",
    "",
    "<!-- decap",
    `commit: ${sha}`,
    "file: src/app.py",
    "lines: 1-3",
    "age: 2 days",
    "change: 2dd27812f1692903",
    "-->",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(dir, "before.png"), "");
  fs.writeFileSync(path.join(dir, "after.png"), "");
}

function commitWhileClosed(workspace: string): void {
  const hook = path.join(workspace, ".git", "hooks", "post-commit");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  fs.writeFileSync(hook, [
    "#!/bin/sh",
    "mkdir -p .decisions/from-hook",
    "printf '%s\\n' '---' 'commit: hook' 'file: src/old.py' 'lines: 1-3' 'age: 2 days' 'change: 9d1dde00241324bf' '---' '' 'Why:' > .decisions/from-hook/note.md",
    "",
  ].join("\n"));
  fs.chmodSync(hook, 0o755);
  const when = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  fs.writeFileSync(path.join(workspace, "src", "old.py"), "def keep():\n    return 2\n");
  commitAt(workspace, ["src/old.py"], "keep two", when);
  commitAt(workspace, ["src/app.py"], "use sum", when);
  fs.writeFileSync(path.join(workspace, "src", "app.py"), "def total(xs):\n    return sum(xs) + 1\n");
  commitAt(workspace, ["src/app.py"], "young", when);
}

async function launch(workspace: string, extra: Record<string, string>): Promise<void> {
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, "../.."),
    extensionTestsPath: path.resolve(__dirname, "./suite/index"),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-gpu",
      "--disable-workspace-trust",
    ],
    extensionTestsEnv: { ...passedEnv(), ...extra },
  });
}

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "decap-ext-"));
  prepareRepo(workspace);
  await launch(workspace, {});

  const outer = fs.mkdtempSync(path.join(os.tmpdir(), "decap-outer-"));
  const inner = path.join(outer, "decap-playground");
  fs.mkdirSync(inner);
  prepareRepo(inner);
  await launch(outer, { DECAP_LAYOUT: "nested", DECAP_INNER: inner });

  const closed = fs.mkdtempSync(path.join(os.tmpdir(), "decap-closed-"));
  prepareRepo(closed);
  await launch(closed, { DECAP_LAYOUT: "closed-prime" });
  commitWhileClosed(closed);
  await launch(closed, { DECAP_LAYOUT: "closed-reopen" });

  const rebase = fs.mkdtempSync(path.join(os.tmpdir(), "decap-rebase-"));
  prepareRebaseRepo(rebase);
  await launch(rebase, { DECAP_LAYOUT: "rebase" });

  const reload = fs.mkdtempSync(path.join(os.tmpdir(), "decap-reload-"));
  prepareRepo(reload);
  await launch(reload, { DECAP_LAYOUT: "status-save" });
  await launch(reload, { DECAP_LAYOUT: "status-reload" });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
