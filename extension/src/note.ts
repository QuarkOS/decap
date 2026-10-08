export interface Note {
  format: "legacy" | "readable";
  commit: string;
  file: string;
  lines: string;
  age: string;
  change: string;
  young: boolean;
  why: string;
}

const EMPTY: Omit<Note, "format" | "why"> = {
  commit: "",
  file: "",
  lines: "",
  age: "",
  change: "",
  young: false,
};

function fieldsOf(block: string): Omit<Note, "format" | "why"> {
  const found: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const at = line.indexOf(":");
    if (at < 0) {
      continue;
    }
    found[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return {
    commit: found.commit ?? "",
    file: found.file ?? "",
    lines: found.lines ?? "",
    age: found.age ?? "",
    change: found.change ?? "",
    young: found.young === "true",
  };
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function parseNote(text: string): Note {
  const note = normalize(text);
  if (note.startsWith("---\n")) {
    const end = note.indexOf("\n---\n", 3);
    const fields = end < 0 ? { ...EMPTY } : fieldsOf(note.slice(4, end));
    const marker = "\nWhy:\n";
    const at = note.indexOf(marker);
    const why = at < 0 ? "" : note.slice(at + marker.length).trim();
    return { format: "legacy", ...fields, why };
  }
  const commentAt = note.indexOf("<!-- decap\n");
  const commentEnd = commentAt < 0 ? -1 : note.indexOf("\n-->", commentAt + 11);
  const fields = commentAt < 0 || commentEnd < 0 ? { ...EMPTY } : fieldsOf(note.slice(commentAt + 11, commentEnd));
  const visible = (commentAt < 0 ? note : note.slice(0, commentAt)).trim();
  const body = visible.split("\n").slice(1).join("\n").trim();
  const why = body.replace(/\n*!\[before\]\(before\.png\)\s*\n!\[after\]\(after\.png\)\s*$/, "").trim();
  return { format: "readable", ...fields, why };
}

export function renderNote(note: Note): string {
  if (note.format === "legacy") {
    const why = note.why.trim() ? `${note.why.trim()}\n` : "";
    return (
      `---\ncommit: ${note.commit}\nfile: ${note.file}\nlines: ${note.lines}\n` +
      `age: ${note.age}\nchange: ${note.change}\n---\n\nWhy:\n${why}`
    );
  }
  const title = note.lines ? `# ${note.file} lines ${note.lines}` : `# ${note.file}`;
  const why = note.why.trim();
  const middle = why ? `\n${why}\n\n` : "\n";
  return (
    `${title}\n${middle}` +
    "![before](before.png)\n![after](after.png)\n\n" +
    "<!-- decap\n" +
    `commit: ${note.commit}\n` +
    `file: ${note.file}\n` +
    `lines: ${note.lines}\n` +
    `age: ${note.age}\n` +
    `change: ${note.change}\n` +
    (note.young ? "young: true\n" : "") +
    "-->\n"
  );
}

export function noteKey(text: string): string | undefined {
  const change = parseNote(text).change;
  return change || undefined;
}

export function applyWhy(text: string, why: string): string {
  const note = normalize(text);
  if (note.startsWith("---\n") && note.indexOf("\n---\n", 3) < 0) {
    return text;
  }
  return renderNote({ ...parseNote(text), why });
}

export function fileTitle(note: Note): string {
  const base = note.file.split(/[/\\]/).pop() || note.file || "capture";
  if (!note.lines) {
    return base;
  }
  if (note.lines === "deleted") {
    return `${base} deleted`;
  }
  return `${base} lines ${note.lines}`;
}

export function fileMeta(note: Note): string {
  const hash = !note.commit || note.commit === "uncommitted" ? note.commit : note.commit.slice(0, 7);
  if (note.age && hash) {
    return `${note.age} · ${hash}`;
  }
  return note.age || hash || "";
}
