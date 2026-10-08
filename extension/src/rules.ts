import { createHash } from "crypto";
import { renderNote } from "./note";

export const MAX_LINES = 60;
export const MAX_COLUMNS = 120;
export const DEFAULT_MIN_AGE_MS = 12 * 60 * 60 * 1000;

const LOCK_NAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "bun.lockb",
  "go.sum",
  "packages.lock.json",
  "shrinkwrap.json",
  "npm-shrinkwrap.json",
]);

const SKIP_SUFFIXES = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".whl", ".wasm", ".so", ".dll", ".pyc", ".woff", ".woff2", ".min.js", ".min.css",
];

export type Kind = "context" | "removed" | "added";

export interface Line {
  kind: Kind;
  text: string;
}

export interface TextHunk {
  path: string;
  oldStart: number;
  newStart: number;
  lines: Line[];
}

export interface ShotLine {
  text: string;
  marked: boolean;
}

export interface Decision {
  key: string;
  slug: string;
  path: string;
  beforeHeader: string;
  afterHeader: string;
  beforeLines: ShotLine[];
  afterLines: ShotLine[];
  beforeStart: number;
  afterStart: number;
  noteMd: string;
  ageMs?: number;
}

type DiffEntry = { type: "hunk"; hunk: TextHunk } | { type: "skip" };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const BLAME = /^([0-9a-fA-F^]+) (\d+) (\d+)(?: (\d+))?$/;

export function parseDiff(text: string): DiffEntry[] {
  const entries: DiffEntry[] = [];
  for (const section of splitLinesKeep(text).split(/(?=^diff --git )/m)) {
    if (section.startsWith("diff --git ")) {
      entries.push(...parseSection(section));
    }
  }
  return entries;
}

function splitLinesKeep(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function splitLines(text: string): string[] {
  const rows = splitLinesKeep(text).split("\n");
  if (rows.length > 0 && rows[rows.length - 1] === "") {
    rows.pop();
  }
  return rows;
}

function parseSection(section: string): DiffEntry[] {
  const lines = splitLines(section);
  const pair = gitPair(lines[0] || "");
  if (lines.some((line) => line.includes("Binary files") || line.includes("GIT binary patch"))) {
    return [{ type: "skip" }];
  }
  let oldPath = pair.right;
  let filePath = pair.right;
  for (const line of lines) {
    if (line.startsWith("--- ")) {
      oldPath = headerPath(line);
    } else if (line.startsWith("+++ ")) {
      filePath = headerPath(line);
    }
  }
  if (oldPath === "/dev/null" || filePath === "/dev/null") {
    return [{ type: "skip" }];
  }
  const hunks: DiffEntry[] = [];
  let index = 0;
  while (index < lines.length) {
    const match = HUNK.exec(lines[index]);
    if (!match) {
      index += 1;
      continue;
    }
    const oldStart = Number(match[1]);
    const newStart = Number(match[2]);
    index += 1;
    const body: Line[] = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith("+")) {
        body.push({ kind: "added", text: line.slice(1).replace(/\r+$/, "") });
      } else if (line.startsWith("-")) {
        body.push({ kind: "removed", text: line.slice(1).replace(/\r+$/, "") });
      } else if (line.startsWith(" ")) {
        body.push({ kind: "context", text: line.slice(1).replace(/\r+$/, "") });
      } else if (line.startsWith("\\")) {
        index += 1;
        continue;
      } else {
        break;
      }
      index += 1;
    }
    hunks.push({ type: "hunk", hunk: { path: filePath, oldStart, newStart, lines: body } });
  }
  return hunks;
}

function gitPair(header: string): { left: string; right: string } {
  let rest = header.slice("diff --git ".length).trim();
  let left: string;
  let right: string;
  if (rest.startsWith("\"")) {
    const first = unquote(rest);
    const second = unquote(first.rest.trimStart());
    left = first.value;
    right = second.value;
  } else {
    const mark = rest.indexOf(" b/");
    if (mark === -1) {
      left = rest;
      right = rest;
    } else {
      left = rest.slice(0, mark);
      right = rest.slice(mark + 1);
    }
  }
  return { left: stripAb(left), right: stripAb(right) };
}

function unquote(text: string): { value: string; rest: string } {
  let end = 1;
  while (end < text.length) {
    if (text[end] === "\\") {
      end += 2;
      continue;
    }
    if (text[end] === "\"") {
      return { value: text.slice(1, end), rest: text.slice(end + 1) };
    }
    end += 1;
  }
  return { value: text, rest: "" };
}

function stripAb(filePath: string): string {
  if (filePath.startsWith("a/") || filePath.startsWith("b/")) {
    return filePath.slice(2);
  }
  return filePath;
}

function headerPath(line: string): string {
  let rest = line.slice(4).split("\t", 1)[0].trim();
  if (rest.length >= 2 && rest.startsWith("\"") && rest.endsWith("\"")) {
    rest = rest.slice(1, -1);
  }
  return stripAb(rest);
}

export function parseBlame(porcelain: string): Map<number, number> {
  const rows = splitLines(porcelain);
  const found = new Map<number, number>();
  const timeOfCommit = new Map<string, number>();
  let previous: number | undefined;
  let index = 0;
  while (index < rows.length) {
    const match = BLAME.exec(rows[index]);
    if (!match) {
      index += 1;
      continue;
    }
    const sha = match[1].replace(/^\^+/, "");
    const finalLine = Number(match[3]);
    const count = match[4] ? Number(match[4]) : 1;
    index += 1;
    let authorTime: number | undefined;
    while (index < rows.length && !rows[index].startsWith("\t") && !BLAME.test(rows[index])) {
      if (rows[index].startsWith("author-time ")) {
        authorTime = Number(rows[index].split(/\s+/)[1]);
      }
      index += 1;
    }
    if (index < rows.length && rows[index].startsWith("\t")) {
      index += 1;
    }
    if (authorTime === undefined) {
      authorTime = timeOfCommit.get(sha) ?? previous;
    }
    if (authorTime === undefined) {
      continue;
    }
    timeOfCommit.set(sha, authorTime);
    previous = authorTime;
    for (let offset = 0; offset < count; offset += 1) {
      found.set(finalLine + offset, authorTime);
    }
  }
  return found;
}

export function changeKey(source: string, hunk: TextHunk): string {
  let text = `${source}\n${hunk.path}\n${hunk.oldStart}\n${hunk.newStart}\n`;
  for (const [kind, sigil] of [["removed", "-"], ["added", "+"]] as const) {
    for (const line of hunk.lines) {
      if (line.kind === kind) {
        text += `${sigil}${line.text}\n`;
      }
    }
  }
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/** File and changed lines, without line numbers. A rebase can move the lines and keep this. */
export function bodyKey(hunk: TextHunk): string {
  let text = `${hunk.path}\n`;
  for (const [kind, sigil] of [["removed", "-"], ["added", "+"]] as const) {
    for (const line of hunk.lines) {
      if (line.kind === kind) {
        text += `${sigil}${line.text}\n`;
      }
    }
  }
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

export function oldEnough(hunk: TextHunk, blame: Map<number, number>, minAgeMs: number | undefined, now: Date): boolean {
  const removed = hunk.lines.some((line) => line.kind === "removed");
  const age = removed ? hunkAge(hunk, blame, now) : undefined;
  return !(minAgeMs !== undefined && (age === undefined || age < minAgeMs));
}

function hunkAge(hunk: TextHunk, blame: Map<number, number>, now: Date): number | undefined {
  let oldNo = hunk.oldStart;
  const times: number[] = [];
  for (const line of hunk.lines) {
    if (line.kind === "added") {
      continue;
    }
    if (line.kind === "removed") {
      const stamped = blame.get(oldNo);
      times.push(stamped === undefined ? now.getTime() / 1000 : stamped);
    }
    oldNo += 1;
  }
  if (times.length === 0) {
    return undefined;
  }
  const age = now.getTime() - Math.max(...times) * 1000;
  return age < 0 ? 0 : age;
}

export function ageLabel(ageMs: number | undefined): string {
  if (ageMs === undefined) {
    return "";
  }
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) {
    return "less than a minute";
  }
  let count: number;
  let unit: string;
  if (seconds < 3600) {
    count = Math.floor(seconds / 60);
    unit = "minute";
  } else if (seconds < 86400) {
    count = Math.floor(seconds / 3600);
    unit = "hour";
  } else {
    count = Math.floor(seconds / 86400);
    unit = "day";
  }
  return count === 1 ? `1 ${unit}` : `${count} ${unit}s`;
}

function fit(lines: ShotLine[]): ShotLine[] {
  const clipped = lines.map((line) => {
    if (line.text.length <= MAX_COLUMNS) {
      return line;
    }
    return { text: `${line.text.slice(0, MAX_COLUMNS - 1)}…`, marked: line.marked };
  });
  if (clipped.length <= MAX_LINES) {
    return clipped;
  }
  const hidden = clipped.length - MAX_LINES;
  return clipped.slice(0, MAX_LINES).concat([{ text: `… truncated, ${hidden} lines not shown`, marked: false }]);
}

function span(start: number, end: number): string {
  return start === end ? String(start) : `${start}-${end}`;
}

function sides(hunk: TextHunk): {
  before: ShotLine[];
  after: ShotLine[];
  beforeStart: number;
  afterStart: number;
  beforeSpan: string;
  afterSpan: string;
} {
  const before: ShotLine[] = [];
  const after: ShotLine[] = [];
  let oldNo = hunk.oldStart;
  let newNo = hunk.newStart;
  let oldEnd: number | undefined;
  let newEnd: number | undefined;
  let afterStart = 1;
  for (const line of hunk.lines) {
    if (line.kind === "removed") {
      before.push({ text: line.text, marked: true });
      oldEnd = oldNo;
      oldNo += 1;
      continue;
    }
    if (line.kind === "added") {
      if (after.length === 0) {
        afterStart = newNo || 1;
      }
      after.push({ text: line.text, marked: true });
      newEnd = newNo;
      newNo += 1;
      continue;
    }
    if (after.length === 0) {
      afterStart = newNo || 1;
    }
    before.push({ text: line.text, marked: false });
    after.push({ text: line.text, marked: false });
    oldEnd = oldNo;
    newEnd = newNo;
    oldNo += 1;
    newNo += 1;
  }
  const beforeStart = before.length > 0 && hunk.oldStart ? hunk.oldStart : 1;
  let afterSpan: string;
  if (after.length === 0) {
    after.push({ text: "(deleted)", marked: false });
    afterStart = 1;
    afterSpan = "deleted";
  } else {
    afterSpan = newEnd === undefined ? "" : span(afterStart, newEnd);
  }
  const beforeSpan = oldEnd === undefined ? "" : span(beforeStart, oldEnd);
  return {
    before: fit(before),
    after: fit(after),
    beforeStart,
    afterStart,
    beforeSpan,
    afterSpan,
  };
}

export function noteLines(hunk: TextHunk): string {
  const shaped = sides(hunk);
  return shaped.beforeSpan || shaped.afterSpan;
}

export function ignored(filePath: string): boolean {
  const name = filePath.split(/[/\\]/).pop() || filePath;
  return LOCK_NAMES.has(name) || name.endsWith(".lock") || SKIP_SUFFIXES.some((suffix) => filePath.endsWith(suffix));
}

function header(filePath: string, lineSpan: string, label: string): string {
  const lived = label ? `  ·  lived ${label}` : "";
  if (lineSpan === "deleted") {
    return `${filePath}  deleted${lived}`;
  }
  if (!lineSpan) {
    return `${filePath}${lived}`;
  }
  return `${filePath}  lines ${lineSpan}${lived}`;
}

function decision(hunk: TextHunk, key: string, age: number | undefined, commit: string, young: boolean): Decision {
  const shaped = sides(hunk);
  const label = ageLabel(age);
  const slugBody = hunk.path.replace(/[^A-Za-z0-9._-]/g, "_");
  const noteSpan = shaped.beforeSpan || shaped.afterSpan;
  const noteMd = renderNote({
    format: "readable",
    commit,
    file: hunk.path,
    lines: noteSpan,
    age: label,
    change: key,
    why: "",
    young,
  });
  return {
    key,
    slug: `${slugBody}_${hunk.oldStart}`.slice(0, 60),
    path: hunk.path,
    beforeHeader: header(hunk.path, shaped.beforeSpan, label),
    afterHeader: header(hunk.path, shaped.afterSpan, label),
    beforeLines: shaped.before,
    afterLines: shaped.after,
    beforeStart: shaped.beforeStart,
    afterStart: shaped.afterStart,
    noteMd,
    ageMs: age,
  };
}

export function selectDecisions(input: {
  entries: DiffEntry[];
  blameOf: (filePath: string) => Map<number, number>;
  source: string;
  commit: string;
  minAgeMs: number | undefined;
  captured: Set<string>;
  now: Date;
  markYoungBelowMs?: number;
}): Decision[] {
  const seen = new Set(input.captured);
  const chosen: Decision[] = [];
  for (const entry of input.entries) {
    if (entry.type !== "hunk" || ignored(entry.hunk.path)) {
      continue;
    }
    if (!oldEnough(entry.hunk, input.blameOf(entry.hunk.path), input.minAgeMs, input.now)) {
      continue;
    }
    const removed = entry.hunk.lines.some((line) => line.kind === "removed");
    const age = removed ? hunkAge(entry.hunk, input.blameOf(entry.hunk.path), input.now) : undefined;
    const key = changeKey(input.source, entry.hunk);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const young = input.markYoungBelowMs !== undefined && age !== undefined && age < input.markYoungBelowMs;
    chosen.push(decision(entry.hunk, key, age, input.commit, young));
  }
  return chosen;
}
