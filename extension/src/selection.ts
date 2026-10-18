import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { runGit } from "./capture";
import { parseNote } from "./note";

export class EditorLines {
  static inclusive(startLine: number, startChar: number, endLine: number, endChar: number, empty: boolean): { start: number; end: number } {
    const start = startLine + 1;
    if (empty) {
      return { start, end: start };
    }
    const end = endChar === 0 ? endLine : endLine + 1;
    return { start, end: Math.max(start, end) };
  }
}

export class RepoFile {
  static relative(root: string, file: string): string | undefined {
    const rel = path.relative(path.resolve(root), path.resolve(file));
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      return undefined;
    }
    return rel.split(path.sep).join("/");
  }
}

export class FileDiff {
  static between(root: string, rel: string, before: string, after: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decap-sel-"));
    const left = path.join(dir, "before");
    const right = path.join(dir, "after");
    fs.writeFileSync(left, before);
    fs.writeFileSync(right, after);
    try {
      const result = runGit(root, ["diff", "--no-index", "--no-ext-diff", "--ignore-cr-at-eol", "-U3", "--", left, right]);
      if ((result.code !== 0 && result.code !== 1) || result.stdout.trim() === "") {
        return "";
      }
      return FileDiff.rewrite(result.stdout, rel);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  static head(root: string, rel: string): string | undefined {
    const result = runGit(root, ["show", `HEAD:${rel}`]);
    if (result.code !== 0) {
      return undefined;
    }
    return result.stdout;
  }

  static rewrite(diffText: string, rel: string): string {
    const quoted = /[\s"]/.test(rel);
    const body = quoted ? rel.replace(/\\/g, "\\\\").replace(/"/g, '\\"') : rel;
    const token = (prefix: string) => quoted ? `"${prefix}/${body}"` : `${prefix}/${rel}`;
    return diffText.replace(/\r\n/g, "\n").split("\n").map((line) => {
      if (line.startsWith("diff --git ")) {
        return `diff --git ${token("a")} ${token("b")}`;
      }
      if (line.startsWith("--- ")) {
        return `--- ${token("a")}`;
      }
      if (line.startsWith("+++ ")) {
        return `+++ ${token("b")}`;
      }
      return line;
    }).join("\n");
  }

  static committed(root: string, commit: string, rel: string): string {
    const result = runGit(root, ["diff", "-U3", "--no-ext-diff", "--ignore-cr-at-eol", `${commit}^`, commit, "--", rel]);
    return result.code === 0 ? result.stdout : "";
  }
}

export class Snippet {
  static markdown(input: { file: string; lines: string; age: string; commit: string; why: string; diff: string }): string {
    const title = input.lines ? `${input.file} lines ${input.lines}` : input.file;
    const hash = !input.commit || input.commit === "uncommitted" ? input.commit : input.commit.slice(0, 7);
    const meta = [input.age, hash].filter((item) => item !== "").join(" · ");
    const why = input.why.trim();
    const hunk = Snippet.hunks(input.diff);
    const parts = [`### ${title}`];
    if (why !== "") {
      parts.push("", why);
    }
    if (meta !== "") {
      parts.push("", meta);
    }
    if (hunk !== "") {
      parts.push("", "```diff", hunk, "```");
    }
    return `${parts.join("\n")}\n`;
  }

  static hunks(diff: string): string {
    const kept: string[] = [];
    let inside = false;
    for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
      if (line.startsWith("diff --git ") && inside) {
        break;
      }
      if (line.startsWith("@@")) {
        inside = true;
      }
      if (inside) {
        kept.push(line);
      }
    }
    return kept.join("\n").trim();
  }

  static fromFolder(folder: string): string {
    const notePath = path.join(folder, "note.md");
    const note = parseNote(fs.readFileSync(notePath, "utf8"));
    const root = path.dirname(path.dirname(folder));
    let diff = "";
    if (note.commit && note.commit !== "uncommitted" && note.file) {
      diff = FileDiff.committed(root, note.commit, note.file);
    } else if (note.file) {
      const before = FileDiff.head(root, note.file);
      if (before !== undefined) {
        let after = "";
        try {
          after = fs.readFileSync(path.join(root, note.file), "utf8");
        } catch {
          after = before;
        }
        diff = FileDiff.between(root, note.file, before, after);
      }
    }
    return Snippet.markdown({
      file: note.file,
      lines: note.lines,
      age: note.age,
      commit: note.commit,
      why: note.why,
      diff,
    });
  }
}

export function toplevel(start: string): string {
  const result = runGit(start, ["rev-parse", "--show-toplevel"]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || "git command failed");
  }
  return result.stdout.trim();
}
