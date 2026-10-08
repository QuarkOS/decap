const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { renderWhyPanel } = require("../out/panel");
const { renderPng } = require("../out/render");

function chromeBin() {
  const names = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
  for (const name of names) {
    try {
      execFileSync("which", [name], { stdio: "ignore" });
      return name;
    } catch {
      continue;
    }
  }
  return undefined;
}

async function main() {
  const out = path.join(__dirname, "..", "media", "why-panel-dark.png");
  const chrome = chromeBin();
  if (!chrome) {
    if (fs.existsSync(out)) {
      console.log("chrome is not installed, leaving the existing screenshot");
      return;
    }
    throw new Error("chrome is not installed");
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "decap-why-"));
  const font = path.join(__dirname, "..", "media", "DejaVuSansMono.ttf");
  await renderPng({
    lines: [
      { text: "def total(xs):", marked: false },
      { text: "    s = 0", marked: true },
      { text: "    return s", marked: true },
    ],
    header: "main.py  lines 8-14  ·  lived 3 days",
    lexerPath: "main.py",
    firstLine: 8,
    dest: path.join(dir, "before.png"),
    tint: "#fde8e8",
    fontFile: font,
  });
  await renderPng({
    lines: [
      { text: "def total(xs):", marked: false },
      { text: "    return sum(xs)", marked: true },
    ],
    header: "main.py  lines 8-14  ·  lived 3 days",
    lexerPath: "main.py",
    firstLine: 8,
    dest: path.join(dir, "after.png"),
    tint: "#e6f4ea",
    fontFile: font,
  });
  const html = renderWhyPanel({
    title: "main.py lines 8-14",
    meta: "3 days · e566311",
    beforeSrc: `data:image/png;base64,${fs.readFileSync(path.join(dir, "before.png")).toString("base64")}`,
    afterSrc: `data:image/png;base64,${fs.readFileSync(path.join(dir, "after.png")).toString("base64")}`,
    why: "",
  });
  const page = path.join(dir, "panel.html");
  fs.writeFileSync(page, html);
  const shot = path.join(dir, "shot.png");
  await new Promise((resolve, reject) => {
    const child = spawn(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--hide-scrollbars",
      "--no-first-run",
      `--screenshot=${shot}`,
      "--window-size=920,780",
      `file://${page}`,
    ], { stdio: "ignore" });
    const started = Date.now();
    let settled = false;
    const finish = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(timer);
      child.kill("SIGKILL");
      if (err) {
        reject(err);
        return;
      }
      resolve();
    };
    const timer = setInterval(() => {
      if (fs.existsSync(shot) && fs.statSync(shot).size > 1000) {
        finish();
        return;
      }
      if (Date.now() - started > 20000) {
        finish(new Error(`screenshot was not written to ${shot}`));
      }
    }, 200);
    child.on("error", (err) => finish(err));
  });
  fs.copyFileSync(shot, out);
  console.log(out);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
