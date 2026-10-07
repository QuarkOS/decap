import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { renderPng } from "./render";
import { Decision, DEFAULT_MIN_AGE_MS, parseBlame, parseDiff, selectDecisions } from "./rules";

const FRESH_COMMIT_SECONDS = 180;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

function git(root: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync("git", ["-c", "color.ui=never", "-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const failed = err as { status?: number; stdout?: string; stderr?: string };
    return {
      code: failed.status ?? 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? ""),
    };
  }
}

function gitText(root: string, args: string[]): string {
  const result = git(root, args);
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || "git command failed";
    throw new Error(detail);
  }
  return result.stdout;
}

function toplevel(start: string): string {
  return gitText(start, ["rev-parse", "--show-toplevel"]).trim();
}

function revExists(root: string, rev: string): boolean {
  return git(root, ["rev-parse", "--verify", rev]).code === 0;
}

export function commitIsFresh(root: string, now = new Date()): boolean {
  const result = git(root, ["show", "-s", "--format=%ct", "HEAD"]);
  if (result.code !== 0) {
    return false;
  }
  const stamp = Number(result.stdout.trim());
  return Number.isFinite(stamp) && now.getTime() / 1000 - stamp < FRESH_COMMIT_SECONDS;
}

function minAgeMs(root: string): number {
  const result = git(root, ["config", "--get", "decap.minAge"]);
  if (result.code === 1 || result.stdout.trim() === "") {
    return DEFAULT_MIN_AGE_MS;
  }
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git command failed");
  }
  const hours = Number(result.stdout.trim());
  if (!Number.isFinite(hours) || hours < 0) {
    throw new Error("decap.minAge must be a non-negative number of hours");
  }
  return hours * 60 * 60 * 1000;
}

function diff(root: string, revs: string[]): string {
  return gitText(root, [
    "diff", "-U3", "--no-renames", "--no-ext-diff", "--ignore-cr-at-eol", ...revs,
  ]);
}

function capturedKeys(root: string): Set<string> {
  const dir = path.join(root, ".decisions");
  const keys = new Set<string>();
  if (!fs.existsSync(dir)) {
    return keys;
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) {
      continue;
    }
    const note = path.join(dir, name, "note.md");
    if (!fs.existsSync(note)) {
      continue;
    }
    const text = fs.readFileSync(note, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const key = noteKey(text);
    if (key) {
      keys.add(key);
    }
  }
  return keys;
}

function noteKey(text: string): string | undefined {
  if (!text.startsWith("---\n")) {
    return undefined;
  }
  const end = text.indexOf("\n---\n", 3);
  if (end < 0) {
    return undefined;
  }
  for (const line of text.slice(4, end).split("\n")) {
    if (line.startsWith("change:")) {
      return line.split(":").slice(1).join(":").trim();
    }
  }
  return undefined;
}

function stamp(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function publish(decision: Decision, root: string, now: Date, fontFile: string): Promise<string> {
  const partial = path.join(root, ".decisions", `.partial-${decision.key}`);
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial, { recursive: true });
  await renderPng({
    lines: decision.beforeLines,
    header: decision.beforeHeader,
    lexerPath: decision.path,
    firstLine: decision.beforeStart,
    dest: path.join(partial, "before.png"),
    tint: "#fde8e8",
    fontFile,
  });
  await renderPng({
    lines: decision.afterLines,
    header: decision.afterHeader,
    lexerPath: decision.path,
    firstLine: decision.afterStart,
    dest: path.join(partial, "after.png"),
    tint: "#e6f4ea",
    fontFile,
  });
  fs.writeFileSync(path.join(partial, "note.md"), decision.noteMd);
  let dest = path.join(root, ".decisions", `${stamp(now)}_${decision.slug}`);
  if (fs.existsSync(dest)) {
    dest = path.join(root, ".decisions", `${stamp(now)}_${decision.slug}_${decision.key.slice(0, 6)}`);
  }
  try {
    fs.renameSync(partial, dest);
  } catch {
    fs.cpSync(partial, dest, { recursive: true });
    fs.rmSync(partial, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(dest, "note.md"), decision.noteMd);
  return dest;
}

export async function capture(input: {
  start: string;
  source: "commit" | "worktree";
  fontFile: string;
  now?: Date;
}): Promise<string[]> {
  const now = input.now ?? new Date();
  const root = toplevel(input.start);
  let revs: string[];
  let minAge: number | undefined;
  let commit: string;
  if (input.source === "commit") {
    if (revExists(root, "HEAD^2") || !revExists(root, "HEAD^")) {
      return [];
    }
    revs = ["HEAD^", "HEAD"];
    minAge = minAgeMs(root);
    commit = gitText(root, ["rev-parse", "HEAD"]).trim();
  } else {
    revs = ["HEAD"];
    minAge = undefined;
    commit = "uncommitted";
  }
  const blameRev = input.source === "commit" ? "HEAD^" : "HEAD";
  const cache = new Map<string, Map<number, number>>();
  const chosen = selectDecisions({
    entries: parseDiff(diff(root, revs)),
    blameOf: (filePath) => {
      const cached = cache.get(filePath);
      if (cached) {
        return cached;
      }
      const result = git(root, ["blame", "-p", blameRev, "--", filePath]);
      const parsed = parseBlame(result.code === 0 ? result.stdout : "");
      cache.set(filePath, parsed);
      return parsed;
    },
    source: input.source,
    commit,
    minAgeMs: minAge,
    captured: capturedKeys(root),
    now,
  });
  const written: string[] = [];
  for (const decision of chosen) {
    written.push(await publish(decision, root, now, input.fontFile));
  }
  return written;
}
