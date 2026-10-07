import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

export interface Tools {
  decap: boolean;
  pipx: boolean;
  pip: boolean;
}

export interface InstallPlan {
  text: string;
  command: string[];
}

export function explainInstall(tools: Tools, target: string): InstallPlan {
  if (tools.decap) {
    return { text: "", command: [] };
  }
  if (tools.pipx) {
    return {
      text: `decap is not installed. Install will run: pipx install ${target}. That adds the decap command for your user and does not change this repository.`,
      command: ["pipx", "install", target],
    };
  }
  if (tools.pip) {
    return {
      text: `decap is not installed. pipx was not found. Install will run: python -m pip install --user ${target}. That adds the decap command for your user and does not change this repository.`,
      command: ["python", "-m", "pip", "install", "--user", target],
    };
  }
  return {
    text: "decap is not installed, and neither pipx nor pip is on PATH. Install pipx or pip, then run decap: Install CLI again.",
    command: [],
  };
}

export function explainHook(): string {
  return "This repository has no decap hook yet. Install hook will run: decap install. That appends a post-commit hook and leaves any existing hook text in place.";
}

export function installTarget(extensionPath: string, workspace: string | undefined): string {
  const candidates = [workspace, path.resolve(extensionPath, "..")].filter(
    (item): item is string => Boolean(item),
  );
  for (const root of candidates) {
    const file = path.join(root, "pyproject.toml");
    if (!fs.existsSync(file)) {
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    if (text.includes('name = "decap"')) {
      return root;
    }
  }
  return "git+https://github.com/QuarkOS/decap.git";
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

export function hookInstalled(root: string): boolean {
  const hook = hookPath(root);
  if (!fs.existsSync(hook)) {
    return false;
  }
  return fs.readFileSync(hook, "utf8").includes("# decap: begin");
}

export async function offer(input: {
  tools: Tools;
  root: string;
  extensionPath: string;
  ask: (text: string, buttons: string[]) => Thenable<string | undefined>;
  run: (command: string[], cwd: string) => Promise<boolean>;
}): Promise<string | undefined> {
  if (!fs.existsSync(path.join(input.root, ".git"))) {
    return undefined;
  }
  if (!input.tools.decap) {
    const plan = explainInstall(input.tools, installTarget(input.extensionPath, input.root));
    const choice = await input.ask(plan.text, plan.command.length ? ["Install", "Not now"] : ["OK"]);
    if (choice !== "Install") {
      return plan.text;
    }
    const installed = await input.run(plan.command, input.root);
    if (!installed) {
      return plan.text;
    }
  }
  if (!hookInstalled(input.root)) {
    const text = explainHook();
    const choice = await input.ask(text, ["Install hook", "Not now"]);
    if (choice === "Install hook") {
      await input.run(["decap", "install"], input.root);
    }
    return text;
  }
  return undefined;
}
