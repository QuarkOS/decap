import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { renderPng } from "./render";
import { noteKey } from "./note";
import { Decision, DEFAULT_MIN_AGE_MS, parseBlame, parseDiff, selectDecisions } from "./rules";

const FRESH_COMMIT_SECONDS = 180;

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

let gitPath = "git";

export function setGitPath(value: string | undefined) {
  if (value) {
    gitPath = value;
  }
}

function git(root: string, args: string[]): GitResult {
  try {
    const stdout = execFileSync(gitPath, ["-c", "color.ui=never", "-C", root, ...args], {
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: 0, stdout, stderr: "" };
  } catch (err) {
    const failed = err as { status?: number; stdout?: string; stderr?: string; code?: string; message?: string };
    return {
      code: failed.status ?? 1,
      stdout: String(failed.stdout ?? ""),
      stderr: String(failed.stderr ?? (failed.code ? `${failed.code}: ${failed.message ?? ""}` : "")),
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
  return commitFreshness(root, now).fresh;
}

export function commitFreshness(root: string, now = new Date()): { fresh: boolean; detail: string } {
  const result = git(root, ["show", "-s", "--format=%ct", "HEAD"]);
  if (result.code !== 0) {
    return { fresh: false, detail: `git failed: ${result.stderr.trim() || "unknown error"}` };
  }
  const stamp = Number(result.stdout.trim());
  if (!Number.isFinite(stamp)) {
    return { fresh: false, detail: "HEAD has no committer time" };
  }
  const age = Math.round(now.getTime() / 1000 - stamp);
  if (age >= FRESH_COMMIT_SECONDS) {
    return { fresh: false, detail: `HEAD was committed ${age}s ago (older than ${FRESH_COMMIT_SECONDS}s), so it is not a new commit` };
  }
  return { fresh: true, detail: `committed ${age}s ago` };
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

export interface CaptureResult {
  root: string;
  commit: string;
  written: string[];
  skipped?: "merge" | "first" | "no-text" | "added-only" | "captured" | "young";
  minAgeHours?: number;
  oldestMs?: number;
}

export async function capture(input: {
  start: string;
  source: "commit" | "worktree";
  fontFile: string;
  now?: Date;
}): Promise<string[]> {
  return (await captureDetailed(input)).written;
}

export async function captureDetailed(input: {
  start: string;
  source: "commit" | "worktree";
  fontFile: string;
  now?: Date;
  anyAge?: boolean;
}): Promise<CaptureResult> {
  const now = input.now ?? new Date();
  const root = toplevel(input.start);
  let revs: string[];
  let minAge: number | undefined;
  let configured: number | undefined;
  let commit: string;
  if (input.source === "commit") {
    if (revExists(root, "HEAD^2")) {
      return { root, commit: "HEAD", written: [], skipped: "merge" };
    }
    if (!revExists(root, "HEAD^")) {
      return { root, commit: "HEAD", written: [], skipped: "first" };
    }
    revs = ["HEAD^", "HEAD"];
    configured = minAgeMs(root);
    minAge = input.anyAge ? 0 : configured;
    commit = gitText(root, ["rev-parse", "HEAD"]).trim();
  } else {
    revs = ["HEAD"];
    minAge = undefined;
    configured = undefined;
    commit = "uncommitted";
  }
  const blameRev = input.source === "commit" ? "HEAD^" : "HEAD";
  const cache = new Map<string, Map<number, number>>();
  const entries = parseDiff(diff(root, revs));
  const blameOf = (filePath: string) => {
      const cached = cache.get(filePath);
      if (cached) {
        return cached;
      }
      const result = git(root, ["blame", "-p", blameRev, "--", filePath]);
      const parsed = parseBlame(result.code === 0 ? result.stdout : "");
      cache.set(filePath, parsed);
      return parsed;
  };
  const select = (gate: number | undefined, captured: Set<string>, markYoungBelowMs?: number) => selectDecisions({
    entries, blameOf, source: input.source, commit, minAgeMs: gate, captured, now, markYoungBelowMs,
  });
  const chosen = select(minAge, capturedKeys(root), input.anyAge ? configured : undefined);
  const written: string[] = [];
  for (const decision of chosen) {
    written.push(await publish(decision, root, now, input.fontFile));
  }
  const result: CaptureResult = {
    root,
    commit,
    written,
    minAgeHours: configured === undefined ? undefined : configured / 3600000,
  };
  if (written.length > 0) {
    return result;
  }
  const hunks = entries.filter((entry) => entry.type === "hunk");
  if (hunks.length === 0) {
    return { ...result, skipped: "no-text" };
  }
  if (!hunks.some((entry) => entry.type === "hunk" && entry.hunk.lines.some((line) => line.kind === "removed"))) {
    return { ...result, skipped: "added-only" };
  }
  if (select(minAge, new Set()).length > 0) {
    return { ...result, skipped: "captured" };
  }
  const any = select(0, new Set());
  if (any.length === 0) {
    return { ...result, skipped: "no-text" };
  }
  const oldest = Math.max(...any.map((item) => item.ageMs ?? 0));
  return { ...result, skipped: "young", oldestMs: oldest };
}
