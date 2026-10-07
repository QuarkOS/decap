import * as fs from "fs";
import * as path from "path";

export interface Entry {
  folder: string;
  name: string;
  note: string;
  before: string;
  after: string;
}

export function listDecisions(root: string): Entry[] {
  const dir = path.join(root, ".decisions");
  if (!fs.existsSync(dir)) {
    return [];
  }
  const names = fs.readdirSync(dir).filter((name) => {
    if (name.startsWith(".")) {
      return false;
    }
    return fs.statSync(path.join(dir, name)).isDirectory();
  });
  names.sort();
  names.reverse();
  return names.map((name) => {
    const folder = path.join(dir, name);
    const notePath = path.join(folder, "note.md");
    const note = fs.existsSync(notePath)
      ? fs.readFileSync(notePath, "utf8").replace(/\r\n/g, "\n")
      : "";
    return {
      folder,
      name,
      note,
      before: path.join(folder, "before.png"),
      after: path.join(folder, "after.png"),
    };
  });
}

export function splitWhy(note: string): { front: string; why: string } {
  const marker = "\nWhy:\n";
  const at = note.indexOf(marker);
  if (at < 0) {
    return { front: note, why: "" };
  }
  return { front: note.slice(0, at + marker.length), why: note.slice(at + marker.length) };
}

export function joinWhy(front: string, why: string): string {
  const body = why.endsWith("\n") ? why : `${why}\n`;
  return front.endsWith("\n") ? front + body : `${front}\n${body}`;
}

export function renderPage(
  entry: Entry | undefined,
  entries: Entry[],
  src: (file: string) => string,
  focusWhy = false,
): string {
  const items = entries.map((item) => {
    const selected = entry && item.folder === entry.folder ? " selected" : "";
    return `<button class="item${selected}" data-folder="${escapeAttr(item.folder)}">${escapeText(label(item))}</button>`;
  }).join("");
  const parts = entry ? splitWhy(entry.note) : { front: "", why: "" };
  const pair = entry
    ? `<div class="pair">
        <figure><figcaption>before</figcaption><img src="${src(entry.before)}" alt="before"></figure>
        <figure><figcaption>after</figcaption><img src="${src(entry.after)}" alt="after"></figure>
      </div>
      <pre class="front">${escapeText(parts.front)}</pre>
      <label for="why">Why</label>
      <textarea id="why"${focusWhy ? " autofocus" : ""}>${escapeText(parts.why)}</textarea>`
    : `<p class="empty">No decisions yet. A capture appears after you commit a change to a line that is at least 12 hours old.</p>`;
  const folder = entry ? entry.folder : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: sans-serif; color: #1c2834; background: #fff; margin: 0; padding: 12px; }
  .list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  button.item { text-align: left; padding: 6px 8px; border: 1px solid #d0d7de; background: #fff; color: inherit; cursor: pointer; }
  button.item.selected { background: #e7eef6; }
  .pair { display: flex; gap: 12px; align-items: flex-start; }
  figure { margin: 0; flex: 1; min-width: 0; }
  figcaption { font-size: 12px; margin-bottom: 4px; }
  img { max-width: 100%; height: auto; border: 1px solid #d0d7de; background: white; }
  pre.front { white-space: pre-wrap; font-size: 12px; }
  textarea { width: 100%; min-height: 80px; box-sizing: border-box; font-family: sans-serif; }
  label { display: block; margin: 8px 0 4px; }
</style>
</head>
<body>
  <div class="list">${items}</div>
  ${pair}
  <script>
    const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    document.querySelectorAll("button.item").forEach((button) => {
      button.addEventListener("click", () => {
        if (vscodeApi) vscodeApi.postMessage({ type: "open", folder: button.dataset.folder });
      });
    });
    const why = document.getElementById("why");
    if (why && vscodeApi) {
      why.addEventListener("change", () => vscodeApi.postMessage({ type: "why", folder: ${JSON.stringify(folder)}, text: why.value }));
    }
    if (why && ${focusWhy ? "true" : "false"}) {
      why.focus();
    }
  </script>
</body>
</html>`;
}

function label(entry: Entry): string {
  const file = entry.note.split("\n").find((line) => line.startsWith("file: "));
  return file ? `${entry.name}  ${file.slice("file: ".length)}` : entry.name;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
