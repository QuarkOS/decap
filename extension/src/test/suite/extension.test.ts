import * as assert from "assert";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

interface Tools {
  decap: boolean;
  pipx: boolean;
  pip: boolean;
}

interface Api {
  explainInstall: (tools: Tools, target: string) => { text: string; command: string[] };
  offer: (input: {
    tools: Tools;
    root: string;
    extensionPath: string;
    ask: (text: string, buttons: string[]) => Thenable<string | undefined>;
    run: (command: string[], cwd: string) => Promise<boolean>;
  }) => Promise<string | undefined>;
  entries: () => { folder: string; name: string; note: string; before: string; after: string }[];
  standaloneHtml: () => string;
  refresh: () => void;
}

async function api(): Promise<Api> {
  const ext = vscode.extensions.getExtension<Api>("decap.decap");
  assert.ok(ext, "decap extension is installed in the test host");
  return ext.activate();
}

suite("decap extension", () => {
  test("activates and registers the commands", async () => {
    await api();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("decap.snap"));
    assert.ok(commands.includes("decap.installHook"));
    assert.ok(commands.includes("decap.openDecisions"));
  });

  test("missing CLI offer names pipx and does not run it", async () => {
    const exported = await api();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root);
    const ext = vscode.extensions.getExtension("decap.decap");
    assert.ok(ext);
    let ran = false;
    const text = await exported.offer({
      tools: { decap: false, pipx: true, pip: false },
      root,
      extensionPath: ext.extensionPath,
      ask: async (message) => {
        assert.ok(message.includes("pipx install"), message);
        return "Not now";
      },
      run: async () => {
        ran = true;
        return true;
      },
    });
    assert.ok(text && text.includes("pipx install"));
    assert.strictEqual(ran, false);

    const neither = exported.explainInstall(
      { decap: false, pipx: false, pip: false },
      "git+https://github.com/QuarkOS/decap.git",
    );
    assert.ok(neither.text.includes("neither pipx nor pip"));
    assert.deepStrictEqual(neither.command, []);
  });

  test("snap puts a before and after entry in the view", async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    assert.ok(root);
    assert.ok(fs.existsSync(path.join(root, ".git")));
    await vscode.commands.executeCommand("decap.snap");
    const exported = await api();
    exported.refresh();
    const entries = exported.entries();
    assert.strictEqual(entries.length, 1, "snap wrote one decision");
    const html = exported.standaloneHtml();
    assert.ok(html.includes('alt="before"'));
    assert.ok(html.includes('alt="after"'));
    assert.ok(html.includes("<textarea id=\"why\">"));
    assert.ok(fs.statSync(entries[0].before).size > 500);
    assert.ok(fs.statSync(entries[0].after).size > 500);

    const shot = process.env.DECAP_VIEW_DIR;
    if (shot) {
      fs.mkdirSync(shot, { recursive: true });
      fs.copyFileSync(entries[0].before, path.join(shot, "before.png"));
      fs.copyFileSync(entries[0].after, path.join(shot, "after.png"));
      fs.writeFileSync(path.join(shot, "view.html"), html);
    }
  });
});
