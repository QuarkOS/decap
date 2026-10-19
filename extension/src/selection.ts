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
    const win32 = process.platform === "win32";
    return RepoFile.compare(root, file, win32)
      ?? RepoFile.compareReal(root, file, win32)
      ?? RepoFile.compareMapped(root, file, win32)
      ?? RepoFile.fromGit(root, file);
  }

  static compare(root: string, file: string, win32: boolean): string | undefined {
    const base = RepoFile.normalize(root, win32);
    const target = RepoFile.normalize(file, win32);
    const posix = win32 ? path.win32 : path;
    const rel = posix.relative(base, target);
    const slash = rel.split(/[\\/]/).join("/");
    if (slash === "" || slash.split("/").includes("..") || posix.isAbsolute(rel)) {
      return undefined;
    }
    return slash;
  }

  static normalize(input: string, win32: boolean): string {
    let text = input.replace(/^\uFEFF/, "").replace(/^\s+/, "").replace(/[\r\n]+$/, "").replace(/\\/g, "/");
    const lowered = text.toLowerCase();
    if (lowered.startsWith("//?/unc/")) {
      text = "//" + text.slice("//?/unc/".length);
    } else if (lowered.startsWith("//?/")) {
      text = text.slice("//?/".length);
    }
    if (win32) {
      const msys = /^\/([a-zA-Z])\/(.*)$/.exec(text);
      if (msys) {
        text = `${msys[1]}:/${msys[2]}`;
      }
      text = text.toLowerCase();
    }
    return (win32 ? path.win32 : path).resolve(text);
  }

  static mapDrive(gitRoot: string, localPath: string, networkRoot: string): string | undefined {
    const gitNorm = RepoFile.normalize(gitRoot, true);
    const network = RepoFile.normalize(networkRoot, true).replace(/\\+$/, "");
    const local = RepoFile.normalize(localPath, true);
    const drive = /^([a-z]):/.exec(local);
    if (!drive) {
      return undefined;
    }
    const gitKey = gitNorm.toLowerCase();
    const networkKey = network.toLowerCase();
    if (gitKey !== networkKey && !gitKey.startsWith(`${networkKey}\\`)) {
      return undefined;
    }
    let suffix = gitNorm.slice(network.length);
    if (suffix !== "" && !suffix.startsWith("\\")) {
      suffix = `\\${suffix}`;
    }
    if (suffix === "") {
      suffix = "\\";
    }
    return path.win32.normalize(`${drive[1]}:${suffix}`);
  }

  private static compareReal(root: string, file: string, win32: boolean): string | undefined {
    const base = RepoFile.real(root);
    const target = RepoFile.real(file);
    if (!base || !target) {
      return undefined;
    }
    return RepoFile.compare(base, target, win32);
  }

  private static compareMapped(root: string, file: string, win32: boolean): string | undefined {
    if (!win32) {
      return undefined;
    }
    const fileDrive = RepoFile.driveLetter(file);
    const rootDrive = RepoFile.driveLetter(root);
    const letter = fileDrive ?? rootDrive;
    if (!letter) {
      return undefined;
    }
    const network = RepoFile.driveNetwork(letter);
    if (!network) {
      return undefined;
    }
    if (fileDrive) {
      const mapped = RepoFile.mapDrive(root, file, network);
      return mapped ? RepoFile.compare(mapped, file, true) : undefined;
    }
    const mappedFile = RepoFile.mapDrive(file, root, network);
    return mappedFile ? RepoFile.compare(root, mappedFile, true) : undefined;
  }

  private static driveLetter(input: string): string | undefined {
    return /^([a-z]):/.exec(RepoFile.normalize(input, true))?.[1];
  }

  private static driveNetwork(letter: string): string | undefined {
    try {
      const resolved = fs.realpathSync.native(`${letter}:\\`);
      const found = RepoFile.normalize(resolved, true).replace(/\\+$/, "");
      const plain = RepoFile.normalize(`${letter}:\\`, true).replace(/\\+$/, "");
      if (found.toLowerCase() === plain.toLowerCase()) {
        return undefined;
      }
      return resolved;
    } catch {
      return undefined;
    }
  }

  private static real(input: string): string | undefined {
    try {
      return fs.realpathSync(path.resolve(input));
    } catch {
      return undefined;
    }
  }

  // Git and the editor can name one folder with different spellings.
  private static fromGit(root: string, file: string): string | undefined {
    const placed = RepoFile.placement(file);
    if (!placed || !RepoFile.sameRepo(root, placed.top)) {
      return undefined;
    }
    return placed.rel;
  }

  private static placement(file: string): { top: string; rel: string } | undefined {
    const dir = RepoFile.cwdOf(file);
    if (!dir) {
      return undefined;
    }
    const top = RepoFile.gitOut(dir, ["rev-parse", "--show-toplevel"]);
    const prefixOut = RepoFile.gitOut(dir, ["rev-parse", "--show-prefix"]);
    if (!top || prefixOut === undefined) {
      return undefined;
    }
    let prefix = prefixOut.replace(/\\/g, "/");
    if (prefix === "." || prefix === "./") {
      prefix = "";
    }
    if (prefix !== "" && !prefix.endsWith("/")) {
      prefix = `${prefix}/`;
    }
    const base = RepoFile.cwdOf(file) === file ? "" : path.basename(file);
    const rel = `${prefix}${base}`.replace(/\/$/, "");
    if (rel === "" || rel.split("/").includes("..")) {
      return undefined;
    }
    return { top, rel };
  }

  private static sameRepo(root: string, fileTop: string): boolean {
    const win32 = process.platform === "win32";
    if (RepoFile.samePlace(root, fileTop, win32)) {
      return true;
    }
    const cwd = RepoFile.cwdOf(root);
    if (!cwd) {
      return false;
    }
    const rootTop = RepoFile.gitOut(cwd, ["rev-parse", "--show-toplevel"]);
    return !!rootTop && RepoFile.samePlace(rootTop, fileTop, win32);
  }

  private static samePlace(left: string, right: string, win32: boolean): boolean {
    if (RepoFile.normalize(left, win32) === RepoFile.normalize(right, win32)) {
      return true;
    }
    const a = RepoFile.real(left);
    const b = RepoFile.real(right);
    return !!a && !!b && RepoFile.normalize(a, win32) === RepoFile.normalize(b, win32);
  }

  private static cwdOf(input: string): string | undefined {
    try {
      return fs.statSync(input).isFile() ? path.dirname(input) : input;
    } catch {
      return undefined;
    }
  }

  private static gitOut(cwd: string, args: string[]): string | undefined {
    const result = runGit(cwd, args);
    if (result.code !== 0) {
      return undefined;
    }
    return result.stdout.replace(/^\uFEFF/, "").replace(/^\s+/, "").replace(/[\r\n]+$/, "");
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
