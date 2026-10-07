const fs = require("fs");
const path = require("path");

const source = path.join(__dirname, "..", "..", "decap.py");
const destDir = path.join(__dirname, "..", "bundled");
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(source, path.join(destDir, "decap.py"));
