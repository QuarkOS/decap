import * as fs from "fs";
import * as path from "path";
import { fileTitle, parseNote } from "./note";

export interface Entry {
  folder: string;
  name: string;
  note: string;
  before: string;
  after: string;
}

export interface DecisionRow {
  folder: string;
  name: string;
  file: string;
  whyLine: string;
  age: string;
}

export function decisionRow(entry: Entry): DecisionRow {
  const note = parseNote(entry.note);
  return {
    folder: entry.folder,
    name: entry.name,
    file: note.file,
    whyLine: firstLine(note.why),
    age: note.age,
  };
}

export function firstLine(why: string): string {
  const line = why.split("\n").find((item) => item.trim() !== "");
  return line ? line.trim() : "";
}

export function rowMatches(row: DecisionRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) {
    return true;
  }
  const fileName = row.file.split(/[/\\]/).pop() || "";
  const haystack = [row.whyLine, row.file, fileName, row.age].join("\n").toLowerCase();
  return haystack.includes(needle);
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

export function renderPage(
  entry: Entry | undefined,
  entries: Entry[],
  src: (file: string) => string,
  focusWhy = false,
  query = "",
  focusSearch = false,
  total = entries.length,
): string {
  const rows = entries.map((item) => decisionRow(item));
  const items = rows.map((row) => {
    const selected = entry && row.folder === entry.folder ? " selected" : "";
    const why = row.whyLine ? `<span class="why">${escapeText(row.whyLine)}</span>` : "";
    return `<button class="item${selected}" data-folder="${escapeAttr(row.folder)}"><span class="title">${escapeText(rowTitle(row))}</span>${why}</button>`;
  }).join("");
  const parsed = entry ? parseNote(entry.note) : undefined;
  const empty = total === 0
    ? "No decisions yet. A capture appears after you commit a change to a line that is at least 12 hours old."
    : "No matching decisions.";
  const pair = entry && parsed
    ? `<div class="pair">
        <figure><figcaption>before</figcaption><img src="${src(entry.before)}" alt="before"></figure>
        <figure><figcaption>after</figcaption><img src="${src(entry.after)}" alt="after"></figure>
      </div>
      <p class="meta">${escapeText(fileTitle(parsed))}</p>
      <label for="why">Why</label>
      <textarea id="why" placeholder="Why did you change this? One or two sentences is enough."${focusWhy ? " autofocus" : ""}>${escapeText(parsed.why)}</textarea>`
    : `<p class="empty">${empty}</p>`;
  const folder = entry ? entry.folder : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); color: var(--vscode-foreground); background: transparent; margin: 0; padding: 12px; }
  .search { width: 100%; box-sizing: border-box; margin-bottom: 8px; font-family: inherit; color: var(--vscode-input-foreground, #cccccc); background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, #3c3c3c); }
  .list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 12px; }
  button.item { display: flex; flex-direction: column; align-items: flex-start; text-align: left; padding: 6px 8px; border: 1px solid var(--vscode-panel-border, #d0d7de); background: transparent; color: inherit; cursor: pointer; }
  button.item.selected { background: var(--vscode-list-activeSelectionBackground, #e7eef6); color: var(--vscode-list-activeSelectionForeground, inherit); }
  .why { display: block; font-size: 12px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  .pair { display: flex; flex-direction: column; gap: 12px; align-items: stretch; }
  figure { margin: 0; flex: 1; min-width: 0; }
  figcaption { font-size: 12px; margin-bottom: 4px; }
  img { max-width: 100%; height: auto; border: 1px solid var(--vscode-panel-border, #3c3c3c); background: transparent; }
  .meta { font-size: 12px; margin: 0 0 4px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  textarea { width: 100%; min-height: 80px; box-sizing: border-box; font-family: inherit; color: var(--vscode-input-foreground, #cccccc); background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, #3c3c3c); }
  label { display: block; margin: 8px 0 4px; }
  label.search-label { margin-top: 0; }
</style>
</head>
<body>
  <label class="search-label" for="search">Search</label>
  <input id="search" class="search" type="search" placeholder="Search by why, file, or age" value="${escapeAttr(query)}">
  <div class="list">${items}</div>
  ${pair}
  <script>
    const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    const search = document.getElementById("search");
    if (search && vscodeApi) {
      search.addEventListener("input", () => vscodeApi.postMessage({ type: "search", text: search.value }));
    }
    if (search && ${focusSearch ? "true" : "false"}) {
      search.focus();
      search.setSelectionRange(search.value.length, search.value.length);
    }
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

function rowTitle(row: DecisionRow): string {
  return row.file ? `${row.name}  ${row.file}` : row.name;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
