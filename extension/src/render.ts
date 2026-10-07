import * as fs from "fs";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import go from "highlight.js/lib/languages/go";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import * as path from "path";
import { encodePNGToStream, make, registerFont } from "pureimage";
import { MAX_COLUMNS, ShotLine } from "./rules";

const FONT_SIZE = 18;
const PADDING = 20;
const LINE_HEIGHT = 26;
const INK = "#24292f";
const NUMBER = "#8b98a5";
const HEADER = "#1c2834";
const BAND = "#e7eef6";

hljs.registerLanguage("python", python);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("go", go);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("yaml", yaml);

const LANGUAGE: Record<string, string> = {
  ".py": "python",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".json": "json",
  ".go": "go",
  ".rs": "rust",
  ".sh": "bash",
  ".css": "css",
  ".html": "xml",
  ".xml": "xml",
  ".md": "markdown",
  ".yml": "yaml",
  ".yaml": "yaml",
};

interface GlyphFont {
  unitsPerEm: number;
  forEachGlyph(
    text: string,
    x: number,
    y: number,
    fontSize: number,
    options: object,
    callback: (glyph: { advanceWidth?: number }, gx: number, gy: number) => void,
  ): void;
}

let loaded: GlyphFont | undefined;
let loadedFrom = "";

function fontOf(file: string): GlyphFont {
  if (!loaded || loadedFrom !== file) {
    if (!fs.existsSync(file)) {
      throw new Error(`The bundled monospace font is missing at ${file}.`);
    }
    const registered = registerFont(file, "DejaVuSansMono").loadSync();
    loaded = registered.font as unknown as GlyphFont;
    loadedFrom = file;
  }
  return loaded;
}

function advance(font: GlyphFont, text: string): number {
  const scale = FONT_SIZE / font.unitsPerEm;
  let width = 0;
  font.forEachGlyph(text, 0, 0, FONT_SIZE, {}, (glyph, x) => {
    width = x + (glyph.advanceWidth || 0) * scale;
  });
  return Math.ceil(width);
}

function marker(line: ShotLine): boolean {
  return line.text.startsWith("… truncated, ") && line.text.endsWith(" lines not shown");
}

function languageOf(file: string): string | undefined {
  return LANGUAGE[path.extname(file).toLowerCase()];
}

function colorFor(cls: string): string {
  if (/string|regexp/.test(cls)) {
    return "#ba2121";
  }
  if (/comment|doctag/.test(cls)) {
    return "#408080";
  }
  if (/keyword|built_in|type|meta/.test(cls)) {
    return "#008000";
  }
  if (/title|function|class/.test(cls)) {
    return "#0000ff";
  }
  if (/number|literal/.test(cls)) {
    return "#666666";
  }
  return INK;
}

function decode(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#x27;/g, "'");
}

function pieces(line: string, language: string | undefined): { text: string; color: string }[] {
  if (!language || line === "") {
    return [{ text: line, color: INK }];
  }
  try {
    const html = hljs.highlight(line, { language, ignoreIllegals: true }).value;
    const parsed = parseHtml(html);
    return parsed.length > 0 ? parsed : [{ text: line, color: INK }];
  } catch {
    return [{ text: line, color: INK }];
  }
}

function parseHtml(html: string): { text: string; color: string }[] {
  const out: { text: string; color: string }[] = [];
  const stack: string[] = [];
  const re = /<\/span>|<span class="([^"]*)">|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html))) {
    if (match[0] === "</span>") {
      stack.pop();
      continue;
    }
    if (match[1] !== undefined) {
      stack.push(match[1]);
      continue;
    }
    if (match[2]) {
      const text = decode(match[2]);
      if (text) {
        out.push({ text, color: colorFor(stack[stack.length - 1] || "") });
      }
    }
  }
  return out;
}

export async function renderPng(input: {
  lines: ShotLine[];
  header: string;
  lexerPath: string;
  firstLine: number;
  dest: string;
  tint: string;
  fontFile: string;
}): Promise<void> {
  const font = fontOf(input.fontFile);
  const px = (text: string) => advance(font, text);
  const numbered = input.lines.filter((line) => !marker(line));
  const lastNo = input.firstLine + Math.max(numbered.length - 1, 0);
  const gutter = px(String(lastNo)) + 16;
  const longest = input.lines.reduce((max, line) => Math.max(max, px(line.text)), 0);
  const natural = PADDING * 2 + Math.max(px(input.header), gutter + longest);
  const cap = PADDING * 2 + gutter + px("M") * (MAX_COLUMNS + 1);
  const width = Math.max(1, Math.min(natural, cap));
  const band = LINE_HEIGHT + PADDING;
  const height = band + LINE_HEIGHT * input.lines.length + PADDING;
  const image = make(width, height);
  const ctx = image.getContext("2d");
  ctx.textBaseline = "top";
  ctx.font = `${FONT_SIZE}px DejaVuSansMono`;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = BAND;
  ctx.fillRect(0, 0, width, band);
  ctx.fillStyle = HEADER;
  ctx.fillText(input.header, PADDING, Math.floor((band - LINE_HEIGHT) / 2));
  const language = languageOf(input.lexerPath);
  let y = band;
  let number = input.firstLine;
  const codeX = PADDING + gutter;
  for (const line of input.lines) {
    if (line.marked) {
      ctx.fillStyle = input.tint;
      ctx.fillRect(0, y, width, LINE_HEIGHT);
    }
    if (marker(line)) {
      ctx.fillStyle = INK;
      ctx.fillText(line.text, codeX, y);
    } else {
      ctx.fillStyle = NUMBER;
      ctx.fillText(String(number), PADDING, y);
      let x = codeX;
      for (const piece of pieces(line.text, language)) {
        ctx.fillStyle = piece.color;
        ctx.fillText(piece.text, x, y);
        x += px(piece.text);
      }
      number += 1;
    }
    y += LINE_HEIGHT;
  }
  await encodePNGToStream(image, fs.createWriteStream(input.dest));
}
