import * as assert from "assert";
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

function git(cwd: string, args: string[], when?: string): void {
  const env = { ...process.env } as NodeJS.ProcessEnv;
  if (when) {
    env.GIT_AUTHOR_DATE = when;
    env.GIT_COMMITTER_DATE = when;
  }
  execFileSync("git", args, { cwd, env, stdio: "pipe" });
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function textOf(result: unknown): { text: string; isError: boolean } {
  const value = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  const block = value.content?.find((item) => item.type === "text");
  return { text: block?.text ?? "", isError: value.isError === true };
}

async function main(): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "decap-mcp-"));
  git(root, ["init"]);
  git(root, ["config", "user.email", "decap@example.com"]);
  git(root, ["config", "user.name", "decap"]);
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src", "app.py");
  fs.writeFileSync(file, "def total(xs):\n    return 0\n");
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "old"], old);
  fs.writeFileSync(file, "def total(xs):\n    return sum(xs)\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "use sum"]);
  const appCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const fresh = path.join(root, "src", "fresh.py");
  fs.writeFileSync(fresh, "x = 1\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fresh base"]);
  fs.writeFileSync(fresh, "x = 2\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "fresh edit"]);

  const server = path.join(__dirname, "..", "mcp.js");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [server],
    env: childEnv(),
    stderr: "pipe",
  });
  const client = new Client({ name: "decap-mcp-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    assert.deepStrictEqual(names, [
      "decap_capture_commit",
      "decap_capture_range",
      "decap_list_captures",
      "decap_read_why",
    ]);

    const captured = textOf(await client.callTool({ name: "decap_capture_commit", arguments: { root, rev: appCommit } }));
    const capture = JSON.parse(captured.text) as { written: string[]; commit: string; skipped?: string };
    assert.strictEqual(captured.isError, false);
    assert.strictEqual(capture.written.length, 1, captured.text);
    assert.ok(fs.existsSync(path.join(capture.written[0], "before.png")));
    assert.ok(fs.existsSync(path.join(capture.written[0], "after.png")));
    assert.ok(fs.readFileSync(path.join(capture.written[0], "note.md"), "utf8").includes("file: src/app.py"));
    process.stdout.write(`decap_capture_commit wrote ${capture.written[0]}\n`);

    const listed = textOf(await client.callTool({ name: "decap_list_captures", arguments: { root } }));
    const rows = JSON.parse(listed.text) as Array<{ folder: string; file: string; why: string; commit: string }>;
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].file, "src/app.py");
    assert.strictEqual(rows[0].why, "");
    assert.strictEqual(rows[0].commit, capture.commit);
    process.stdout.write(`decap_list_captures ${rows[0].file} ${rows[0].commit.slice(0, 7)}\n`);

    const read = textOf(await client.callTool({
      name: "decap_read_why",
      arguments: { root, folder: path.basename(rows[0].folder) },
    }));
    const note = JSON.parse(read.text) as { file: string; why: string; noteMd: string };
    assert.strictEqual(note.file, "src/app.py");
    assert.ok(note.noteMd.includes("src/app.py"));
    process.stdout.write(`decap_read_why ${note.file}\n`);

    const again = textOf(await client.callTool({ name: "decap_capture_commit", arguments: { root, rev: appCommit } }));
    const second = JSON.parse(again.text) as { written: string[]; skipped?: string };
    assert.strictEqual(second.written.length, 0);
    assert.strictEqual(second.skipped, "captured");

    fs.writeFileSync(file, "def total(xs):\n    return len(xs)\n");
    const ranged = textOf(await client.callTool({
      name: "decap_capture_range",
      arguments: { root, file, start: 2, end: 2 },
    }));
    const range = JSON.parse(ranged.text) as { written: string[]; commit: string };
    assert.strictEqual(range.written.length, 1, ranged.text);
    assert.strictEqual(range.commit, "uncommitted");
    const rangeNote = fs.readFileSync(path.join(range.written[0], "note.md"), "utf8");
    assert.ok(rangeNote.includes("commit: uncommitted"));
    process.stdout.write(`decap_capture_range wrote ${path.basename(range.written[0])}\n`);

    const missed = textOf(await client.callTool({
      name: "decap_capture_range",
      arguments: { root, file: "src/app.py", start: 30, end: 40 },
    }));
    const miss = JSON.parse(missed.text) as { written: string[]; skipped?: string };
    assert.strictEqual(miss.written.length, 0);
    assert.strictEqual(miss.skipped, "no-text");

    const outside = textOf(await client.callTool({
      name: "decap_read_why",
      arguments: { root, folder: "../../etc/passwd" },
    }));
    assert.strictEqual(outside.isError, true);
    assert.match(outside.text, /outside \.decisions/);

    const young = textOf(await client.callTool({
      name: "decap_capture_range",
      arguments: { root, file: "src/fresh.py", start: 1, end: 1, rev: "HEAD", anyAge: false },
    }));
    const gated = JSON.parse(young.text) as { written: string[]; skipped?: string };
    assert.strictEqual(gated.written.length, 0);
    assert.strictEqual(gated.skipped, "young", young.text);
    const forced = textOf(await client.callTool({
      name: "decap_capture_range",
      arguments: { root, file: "src/fresh.py", start: 1, end: 1, rev: "HEAD", anyAge: true },
    }));
    const opened = JSON.parse(forced.text) as { written: string[] };
    assert.strictEqual(opened.written.length, 1, forced.text);
    process.stdout.write("stdio tools ok\n");
  } finally {
    await client.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
