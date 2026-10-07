const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const runtime = require("../out/runtime");

function git(repo, args, env) {
  execFileSync("git", args, { cwd: repo, env: env || process.env, stdio: "inherit" });
}

function decapOnPath() {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", ["decap"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (decapOnPath()) {
    console.error("decap is on PATH. This check must run without it.");
    process.exit(1);
  }
  const python = await runtime.findPython();
  if (!python) {
    console.error(runtime.pythonMissingText());
    process.exit(1);
  }
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), "decap-runtime-"));
  const script = path.join(__dirname, "..", "bundled", "decap.py");
  const installed = await runtime.ensureRuntime({
    basePython: python,
    storage,
    script,
    onProgress: (text) => console.log(text),
  });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "decap-hook-"));
  git(repo, ["init"]);
  git(repo, ["config", "user.email", "dev@example.com"]);
  git(repo, ["config", "user.name", "Dev"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  git(repo, ["config", "core.autocrlf", "false"]);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.py"), "def total(xs):\n    s = 0\n    return s\n");
  const past = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const env = { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past };
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "start"], env);
  await runtime.installHook(installed, repo);
  const hook = fs.readFileSync(runtime.hookPath(repo), "utf8").replace(/\\/g, "/");
  if (!hook.includes(runtime.slash(installed.python)) || !hook.includes(runtime.slash(installed.script))) {
    console.error(hook);
    console.error("hook does not call the bundled runtime");
    process.exit(1);
  }
  fs.writeFileSync(path.join(repo, "src", "app.py"), "def total(xs):\n    return sum(xs)\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "use sum"]);
  const notes = fs.existsSync(path.join(repo, ".decisions"))
    ? fs.readdirSync(path.join(repo, ".decisions")).filter((name) => !name.startsWith("."))
    : [];
  if (notes.length !== 1) {
    console.error(`expected one capture, found ${notes.length}`);
    process.exit(1);
  }
  const folder = path.join(repo, ".decisions", notes[0]);
  for (const name of ["before.png", "after.png", "note.md"]) {
    const file = path.join(folder, name);
    if (!fs.existsSync(file) || fs.statSync(file).size < (name.endsWith(".png") ? 500 : 10)) {
      console.error(`missing ${file}`);
      process.exit(1);
    }
  }
  const note = fs.readFileSync(path.join(folder, "note.md"), "utf8");
  if (!note.includes("Why:") || !note.includes("file: src/app.py")) {
    console.error(note);
    process.exit(1);
  }
  const before = notes.length;
  fs.writeFileSync(path.join(repo, "src", "fresh.py"), "def fresh():\n    return 1\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "add fresh"]);
  const after = fs.readdirSync(path.join(repo, ".decisions")).filter((name) => !name.startsWith("."));
  if (after.length !== before) {
    console.error(`fresh commit wrote a capture: ${after.length}`);
    process.exit(1);
  }
  if (decapOnPath()) {
    console.error("setup put decap on PATH");
    process.exit(1);
  }
  const out = process.env.DECAP_E2E_OUT;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    fs.copyFileSync(path.join(folder, "before.png"), path.join(out, "before.png"));
    fs.copyFileSync(path.join(folder, "after.png"), path.join(out, "after.png"));
  }
  console.log(`setup e2e ok ${folder}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
