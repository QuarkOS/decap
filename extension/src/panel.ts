export const WHY_PLACEHOLDER = "Why did you change this? One or two sentences is enough.";
export const SAVED_HOLD_MS = 4000;

export function waitingLine(others: number): string | undefined {
  if (others < 1) {
    return undefined;
  }
  return `${others} more to fill in.`;
}

export interface WhyPanelModel {
  title: string;
  meta: string;
  beforeSrc: string;
  afterSrc: string;
  why: string;
  banner?: string;
  cspSource?: string;
  /** Live panels focus the field. The screenshot leaves it blurred so the caret does not keep the frame busy. */
  autofocus?: boolean;
}

export function renderWhyPanel(model: WhyPanelModel): string {
  const csp = model.cspSource
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${model.cspSource}; style-src 'unsafe-inline'; script-src 'unsafe-inline';">`
    : "";
  const banner = model.banner ? `<p class="banner">${escapeText(model.banner)}</p>` : "";
  const autofocus = model.autofocus !== false;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${csp}
<style>
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; line-height: 1.45; color: var(--vscode-foreground, #cccccc); background: var(--vscode-editor-background, #1e1e1e); margin: 0; padding: 20px 24px 28px; }
  .banner { margin: 0 0 12px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; }
  h1.title { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.25; }
  .meta { margin: 4px 0 16px; color: var(--vscode-descriptionForeground, #9d9d9d); font-size: 12px; }
  .shots { display: flex; flex-wrap: wrap; gap: 12px; align-items: flex-start; }
  figure { flex: 1 1 240px; margin: 0; min-width: 0; }
  figcaption { font-size: 12px; margin: 0 0 4px; color: var(--vscode-descriptionForeground, #9d9d9d); }
  img { display: block; max-width: 100%; height: auto; border: 1px solid var(--vscode-panel-border, #3c3c3c); background: transparent; }
  textarea { display: block; width: 100%; min-height: 96px; margin-top: 16px; box-sizing: border-box; resize: vertical; font: inherit; color: var(--vscode-input-foreground, #cccccc); background: var(--vscode-input-background, #3c3c3c); border: 1px solid var(--vscode-input-border, #3c3c3c); padding: 8px; }
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
  .row { display: flex; justify-content: flex-end; margin-top: 8px; }
  button { font: inherit; font-size: 13px; color: var(--vscode-button-foreground, #ffffff); background: var(--vscode-button-background, #0e639c); border: none; padding: 6px 14px; cursor: pointer; }
  button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
</style>
</head>
<body>
  ${banner}
  <h1 class="title">${escapeText(model.title)}</h1>
  <p class="meta">${escapeText(model.meta)}</p>
  <div class="shots">
    <figure><figcaption>before</figcaption><img src="${escapeAttr(model.beforeSrc)}" alt="before"></figure>
    <figure><figcaption>after</figcaption><img src="${escapeAttr(model.afterSrc)}" alt="after"></figure>
  </div>
  <textarea id="why" placeholder="${escapeAttr(WHY_PLACEHOLDER)}"${autofocus ? " autofocus" : ""}>${escapeText(model.why)}</textarea>
  <div class="row"><button id="save" type="button">Save</button></div>
  <script>
    const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;
    const why = document.getElementById("why");
    const save = () => {
      if (vscodeApi && why) vscodeApi.postMessage({ type: "save", text: why.value });
    };
    const button = document.getElementById("save");
    if (button) button.addEventListener("click", save);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (vscodeApi) vscodeApi.postMessage({ type: "dismiss" });
        return;
      }
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        save();
      }
    });
    const focusWhy = () => {
      if (why) why.focus();
    };
    window.addEventListener("message", (event) => {
      if (event.data && event.data.type === "focus") focusWhy();
    });
    ${autofocus ? "focusWhy();" : ""}
  </script>
</body>
</html>`;
}

export function renderSaved(cspSource?: string): string {
  const csp = cspSource
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`
    : "";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
${csp}
<style>
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; color: var(--vscode-foreground, #cccccc); background: var(--vscode-editor-background, #1e1e1e); margin: 0; padding: 24px; }
</style>
</head>
<body>Saved.</body>
</html>`;
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;");
}
