import * as fs from "fs";
import * as path from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { CaptureResult, captureDetailed } from "./capture";
import { parseNote } from "./note";
import { listDecisions } from "./view";

export class CaptureQuery {
  static repoPath(root: string, file: string): string {
    const abs = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
    const rel = path.relative(path.resolve(root), abs);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("file is outside the repository");
    }
    return rel.split(path.sep).join("/");
  }

  static folder(root: string, name: string): string {
    const decisions = path.resolve(root, ".decisions");
    const target = path.isAbsolute(name) ? path.resolve(name) : path.resolve(decisions, name);
    const rel = path.relative(decisions, target);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error("capture is outside .decisions");
    }
    return target;
  }

  static lines(start: number, end: number): void {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      throw new Error("line range must start at 1 and end on or after the start");
    }
  }
}

export class DecapTools {
  static fontFile(): string {
    return path.join(__dirname, "..", "media", "DejaVuSansMono.ttf");
  }

  static version(): string {
    const file = path.join(__dirname, "..", "package.json");
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string };
    return parsed.version || "0.1.8";
  }

  static async captureCommit(root: string, rev = "HEAD", anyAge = false): Promise<CaptureResult> {
    return captureDetailed({
      start: root,
      source: "commit",
      fontFile: DecapTools.fontFile(),
      rev,
      anyAge,
    });
  }

  static async captureRange(root: string, file: string, start: number, end: number, rev?: string, anyAge = true): Promise<CaptureResult> {
    CaptureQuery.lines(start, end);
    const rel = CaptureQuery.repoPath(root, file);
    return captureDetailed({
      start: root,
      source: rev ? "commit" : "worktree",
      fontFile: DecapTools.fontFile(),
      rev,
      anyAge: rev ? anyAge : undefined,
      only: { path: rel, start, end },
    });
  }

  static list(root: string): Array<{ folder: string; name: string; file: string; lines: string; age: string; commit: string; why: string }> {
    return listDecisions(root).map((entry) => {
      const note = parseNote(entry.note);
      return {
        folder: entry.folder,
        name: entry.name,
        file: note.file,
        lines: note.lines,
        age: note.age,
        commit: note.commit,
        why: note.why,
      };
    });
  }

  static read(root: string, folder: string): { folder: string; file: string; lines: string; age: string; commit: string; why: string; noteMd: string } {
    const dir = CaptureQuery.folder(root, folder);
    const notePath = path.join(dir, "note.md");
    const noteMd = fs.readFileSync(notePath, "utf8");
    const note = parseNote(noteMd);
    return {
      folder: dir,
      file: note.file,
      lines: note.lines,
      age: note.age,
      commit: note.commit,
      why: note.why,
      noteMd,
    };
  }
}

type ToolText = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export class DecapMcp {
  static server(): McpServer {
    const server = new McpServer({ name: "decap", version: DecapTools.version() });
    server.registerTool(
      "decap_capture_commit",
      {
        title: "Capture a commit",
        description: "Save before and after images for lines a commit changed that are at least 12 hours old. Set anyAge to capture younger lines.",
        inputSchema: {
          root: z.string().describe("Absolute path of the git repository."),
          rev: z.string().optional().describe("Commit to capture. Defaults to HEAD."),
          anyAge: z.boolean().optional().describe("Capture lines younger than 12 hours."),
        },
      },
      async ({ root, rev, anyAge }) => DecapMcp.answer(() => DecapTools.captureCommit(root, rev, anyAge ?? false)),
    );
    server.registerTool(
      "decap_capture_range",
      {
        title: "Capture a line range",
        description: "Save before and after images for one file and an inclusive line range. Omit rev to compare the file on disk with HEAD. Pass rev to use that commit. A named range captures young lines unless anyAge is false.",
        inputSchema: {
          root: z.string().describe("Absolute path of the git repository."),
          file: z.string().describe("File path inside the repository."),
          start: z.number().int().describe("First line, counting from 1."),
          end: z.number().int().describe("Last line, counting from 1."),
          rev: z.string().optional().describe("Commit to capture. Omit to use the working tree."),
          anyAge: z.boolean().optional().describe("When rev is set, capture lines younger than 12 hours. Defaults to true."),
        },
      },
      async ({ root, file, start, end, rev, anyAge }) => DecapMcp.answer(() => DecapTools.captureRange(root, file, start, end, rev, anyAge ?? true)),
    );
    server.registerTool(
      "decap_list_captures",
      {
        title: "List captures",
        description: "List saved captures in .decisions, newest first, including the why note.",
        inputSchema: {
          root: z.string().describe("Absolute path of the git repository."),
        },
      },
      async ({ root }) => DecapMcp.answer(() => DecapTools.list(root)),
    );
    server.registerTool(
      "decap_read_why",
      {
        title: "Read a why note",
        description: "Read one capture's why note. folder is a directory name under .decisions or the absolute path returned by decap_list_captures.",
        inputSchema: {
          root: z.string().describe("Absolute path of the git repository."),
          folder: z.string().describe("Capture directory name or absolute path."),
        },
      },
      async ({ root, folder }) => DecapMcp.answer(() => DecapTools.read(root, folder)),
    );
    return server;
  }

  static async listen(): Promise<void> {
    const transport = new StdioServerTransport();
    await DecapMcp.server().connect(transport);
  }

  private static async answer(work: () => Promise<unknown> | unknown): Promise<ToolText> {
    try {
      const value = await work();
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: message }], isError: true };
    }
  }
}

if (require.main === module) {
  DecapMcp.listen().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`${message}\n`);
    process.exit(1);
  });
}
