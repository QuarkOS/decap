import { execFile, execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export const PYTHON_DOWNLOAD = "https://www.python.org/downloads/";

export type SetupGap = "python" | "runtime" | "repo" | "hook" | "ready";

const PROBE = [
  "import sys",
  "if sys.version_info < (3, 11):",
  "    raise SystemExit(1)",
  "print(sys.executable)",
].join("\n");

const CANDIDATES: string[][] = [
  ["python", "-c", PROBE],
  ["python3", "-c", PROBE],
  ["py", "-3", "-c", PROBE],
];

export interface Runtime {
  python: string;
  script: string;
}

export function pythonMissingText(): string {
  return `Python 3.11 or newer was not found. decap needs Python to save before and after images. Install it from ${PYTHON_DOWNLOAD} and then choose Set up decap again.`;
}

export function statusLabel(gap: SetupGap): string | undefined {
  return gap === "ready" ? undefined : "$(warning) Set up decap";
}

export function assess(input: {
  pythonFound: boolean;
  runtimeReady: boolean;
  inRepo: boolean;
  hookReady: boolean;
}): SetupGap {
  if (!input.pythonFound) {
    return "python";
  }
  if (!input.runtimeReady) {
    return "runtime";
  }
  if (!input.inRepo) {
    return "repo";
  }
  if (!input.hookReady) {
    return "hook";
  }
  return "ready";
}

export function setupCopy(gap: SetupGap): { heading: string; body: string; link?: string; button: boolean } {
  if (gap === "python") {
    return {
      heading: "Python was not found",
      body: pythonMissingText(),
      link: PYTHON_DOWNLOAD,
      button: true,
    };
  }
  if (gap === "repo") {
    return {
      heading: "Open a git repository",
      body: "decap saves a before image and an after image when a commit changes an old line. Open a git repository, then set it up.",
      button: false,
    };
  }
  return {
    heading: "Set up decap",
    body: "This repository is not capturing decisions yet. Set up decap creates a private Python environment for the editor and adds a post-commit hook. You do not need the decap command on PATH.",
    button: true,
  };
}

export function capturePrompt(name: string): { message: string; action: string } {
  return { message: `decap saved ${name}`, action: "Fill in why" };
}

export function slash(file: string): string {
  return file.replace(/\\/g, "/");
}

export function venvPython(storage: string): string {
  return process.platform === "win32"
    ? path.join(storage, "runtime", "Scripts", "python.exe")
    : path.join(storage, "runtime", "bin", "python");
}

export function hookPath(root: string): string {
  try {
    const rel = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    const dir = path.isAbsolute(rel) ? rel : path.join(root, rel);
    return path.join(dir, "post-commit");
  } catch {
    return path.join(root, ".git", "hooks", "post-commit");
  }
}

export function hookReady(root: string, runtime: Runtime): boolean {
  const hook = hookPath(root);
  if (!fs.existsSync(hook)) {
    return false;
  }
  const text = fs.readFileSync(hook, "utf8").replace(/\\/g, "/");
  return text.includes("# decap: begin")
    && text.includes(slash(runtime.python))
    && text.includes(slash(runtime.script));
}

export function isGitRepo(root: string | undefined): root is string {
  return Boolean(root && fs.existsSync(path.join(root, ".git")));
}

function run(cmd: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, timeout: 180000 }, (err, _stdout, stderr) => {
      if (err) {
        const detail = String(stderr || "").trim();
        reject(new Error(detail || err.message));
        return;
      }
      resolve();
    });
  });
}

export async function findPython(): Promise<string | undefined> {
  for (const cmd of CANDIDATES) {
    const exe = await probe(cmd).catch(() => undefined);
    if (exe) {
      return exe;
    }
  }
  return undefined;
}

function probe(cmd: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd[0], cmd.slice(1), { timeout: 20000 }, (err, stdout) => {
      if (err) {
        resolve(undefined);
        return;
      }
      const exe = String(stdout).trim().split(/\r?\n/).pop()?.trim();
      resolve(exe || undefined);
    });
  });
}

export async function ensureRuntime(opts: {
  basePython: string;
  storage: string;
  script: string;
  onProgress?: (text: string) => void;
}): Promise<Runtime> {
  if (!fs.existsSync(opts.script)) {
    throw new Error(`The bundled decap script is missing at ${opts.script}.`);
  }
  const python = venvPython(opts.storage);
  const marker = path.join(opts.storage, "runtime", ".decap-ready");
  if (!(fs.existsSync(python) && fs.existsSync(marker))) {
    opts.onProgress?.("Creating the decap Python environment");
    fs.mkdirSync(opts.storage, { recursive: true });
    await run(opts.basePython, ["-m", "venv", path.join(opts.storage, "runtime")]);
    opts.onProgress?.("Installing Pygments and Pillow");
    await run(python, ["-m", "pip", "install", "--disable-pip-version-check", "Pygments", "Pillow"]);
    await run(python, ["-c", "import PIL, pygments"]);
    fs.writeFileSync(marker, "ok\n");
  }
  return { python, script: path.resolve(opts.script) };
}

export async function installHook(runtime: Runtime, repo: string): Promise<void> {
  await run(runtime.python, [
    runtime.script,
    "install",
    "--python",
    runtime.python,
    "--script",
    runtime.script,
  ], repo);
}

export async function runDecap(runtime: Runtime, repo: string, command: "snap" | "hook"): Promise<void> {
  await run(runtime.python, [runtime.script, command], repo);
}
