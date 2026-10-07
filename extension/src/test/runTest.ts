import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

async function main(): Promise<void> {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "decap-ext-"));
  execFileSync("git", ["init"], { cwd: workspace });
  execFileSync("git", ["config", "user.email", "dev@example.com"], { cwd: workspace });
  execFileSync("git", ["config", "user.name", "Dev"], { cwd: workspace });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: workspace });
  execFileSync("git", ["config", "core.autocrlf", "false"], { cwd: workspace });
  const src = path.join(workspace, "src");
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, "app.py"), "def total(xs):\n    s = 0\n    return s\n");
  fs.writeFileSync(path.join(src, "old.py"), "def keep():\n    value = 1\n    return value\n");
  execFileSync("git", ["add", "-A"], { cwd: workspace });
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  execFileSync("git", ["commit", "-m", "start"], {
    cwd: workspace,
    env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past },
  });
  fs.writeFileSync(path.join(src, "app.py"), "def total(xs):\n    return sum(xs)\n");

  const env: Record<string, string> = { DECAP_TEST: "1" };
  for (const key of ["DECAP_VIEW_DIR", "DECAP_E2E_OUT", "DECAP_PYTHON_TRAP"]) {
    const value = process.env[key];
    if (value) {
      env[key] = value;
    }
  }
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, "../.."),
    extensionTestsPath: path.resolve(__dirname, "./suite/index"),
    launchArgs: [
      workspace,
      "--disable-extensions",
      "--disable-gpu",
      "--disable-workspace-trust",
    ],
    extensionTestsEnv: env,
  });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
