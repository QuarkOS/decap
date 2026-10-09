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
    autofocus: false,
  });
  const page = path.join(dir, "panel.html");
  fs.writeFileSync(page, html);
  const shot = path.join(dir, "shot.png");
  await captureShot(chrome, page, shot);
  fs.copyFileSync(shot, out);
  console.log(out);
}

function stopChrome(child) {
  if (!child || !child.pid) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // The process already exited, or it is not a group leader.
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    // already gone
  }
}

function shotReady(shot) {
  try {
    return fs.statSync(shot).size > 1000;
  } catch {
    return false;
  }
}

// Headless Chrome writes --screenshot only after the load settles, and it does not
// flush the file when killed. A focused caret (or any request that never finishes)
// can hold that settle past the old 20s poll. --timeout and --virtual-time-budget
// force the capture and an exit instead.
async function captureShot(chrome, page, shot) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "decap-chrome-"));
  let log = "";
  const child = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--disable-component-update",
    "--disable-default-apps",
    "--disable-hang-monitor",
    "--mute-audio",
    "--enable-features=CDPScreenshotNewSurface",
    `--user-data-dir=${profile}`,
    "--virtual-time-budget=5000",
    "--timeout=8000",
    `--screenshot=${shot}`,
    "--window-size=920,780",
    `file://${page}`,
  ], {
    detached: process.platform !== "win32",
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.on("data", (chunk) => {
    log = (log + chunk.toString()).slice(-4000);
  });
  const started = Date.now();
  let stable = 0;
  try {
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve();
      };
      const timer = setInterval(() => {
        if (shotReady(shot)) {
          const size = fs.statSync(shot).size;
          if (size === stable) {
            finish();
            return;
          }
          stable = size;
        }
        if (Date.now() - started > 30000) {
          const tail = log.trim().split("\n").slice(-12).join("\n");
          finish(new Error(`screenshot was not written to ${shot}${tail ? `\n${tail}` : ""}`));
        }
      }, 200);
      child.on("exit", () => {
        if (shotReady(shot)) {
          finish();
        }
      });
      child.on("error", (err) => finish(err));
    });
  } finally {
    stopChrome(child);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      // Chrome may still be releasing the profile directory.
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
