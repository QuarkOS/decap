import hashlib
import math
import os
import re
import shlex
import shutil
import subprocess
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from enum import Enum
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pygments import lex
from pygments.lexers import TextLexer, get_lexer_for_filename
from pygments.styles import get_style_by_name

DEFAULT_MIN_AGE = timedelta(hours=12)
CONTEXT_LINES = 3
MAX_LINES = 60
MAX_COLUMNS = 120
LOCK_NAMES = frozenset({
    "package-lock.json", "pnpm-lock.yaml", "bun.lockb", "go.sum",
    "packages.lock.json", "shrinkwrap.json", "npm-shrinkwrap.json",
})
SKIP_SUFFIXES = frozenset({
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
    ".whl", ".wasm", ".so", ".dll", ".pyc", ".woff", ".woff2", ".min.js", ".min.css",
})
BEGIN = "# decap: begin"
END = "# decap: end"
_HUNK = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")
_BLAME = re.compile(r"^([0-9a-fA-F^]+) (\d+) (\d+)(?: (\d+))?$")


class Kind(Enum):
    CONTEXT = "context"
    REMOVED = "removed"
    ADDED = "added"


@dataclass(frozen=True)
class Line:
    kind: Kind
    text: str


@dataclass(frozen=True)
class TextHunk:
    path: str
    old_start: int
    new_start: int
    lines: tuple[Line, ...]


@dataclass(frozen=True)
class NewFile:
    path: str


@dataclass(frozen=True)
class BinaryHunk:
    path: str


@dataclass(frozen=True)
class ShotLine:
    text: str
    marked: bool


@dataclass(frozen=True)
class Decision:
    key: str
    slug: str
    path: str
    before_header: str
    after_header: str
    before_lines: tuple[ShotLine, ...]
    after_lines: tuple[ShotLine, ...]
    before_start: int
    after_start: int
    note_md: str


DiffEntry = TextHunk | NewFile | BinaryHunk


def parse_diff(text: str) -> tuple[DiffEntry, ...]:
    entries: list[DiffEntry] = []
    for section in re.split(r"(?=^diff --git )", text, flags=re.M):
        if section.startswith("diff --git "):
            entries.extend(_parse_section(section))
    return tuple(entries)


def _parse_section(section: str) -> tuple[DiffEntry, ...]:
    lines = section.splitlines()
    old_hint, path = _git_pair(lines[0])
    if any("Binary files" in line or "GIT binary patch" in line for line in lines):
        return (BinaryHunk(path),)
    old_path = path
    for line in lines:
        if line.startswith("--- "):
            old_path = _header_path(line)
        elif line.startswith("+++ "):
            path = _header_path(line)
    if old_path == "/dev/null":
        return (NewFile(old_hint if path == "/dev/null" else path),)
    if path == "/dev/null":
        path = old_path
    hunks: list[TextHunk] = []
    index = 0
    while index < len(lines):
        match = _HUNK.match(lines[index])
        if match is None:
            index += 1
            continue
        old_start, new_start = int(match.group(1)), int(match.group(2))
        index += 1
        body: list[Line] = []
        while index < len(lines):
            line = lines[index]
            if line.startswith("+"):
                body.append(Line(Kind.ADDED, line[1:].rstrip("\r")))
            elif line.startswith("-"):
                body.append(Line(Kind.REMOVED, line[1:].rstrip("\r")))
            elif line.startswith(" "):
                body.append(Line(Kind.CONTEXT, line[1:].rstrip("\r")))
            elif line.startswith("\\"):
                pass
            else:
                break
            index += 1
        hunks.append(TextHunk(path, old_start, new_start, tuple(body)))
    return tuple(hunks)


def _git_pair(header: str) -> tuple[str, str]:
    rest = header[len("diff --git "):].strip()
    if rest.startswith('"'):
        left, rest = _unquote(rest)
        right, _rest = _unquote(rest.lstrip())
    else:
        mark = rest.find(" b/")
        left, right = (rest, rest) if mark == -1 else (rest[:mark], rest[mark + 1:])
    return _strip_ab(left), _strip_ab(right)


def _unquote(text: str) -> tuple[str, str]:
    end = 1
    while end < len(text):
        if text[end] == "\\":
            end += 2
            continue
        if text[end] == '"':
            return text[1:end], text[end + 1:]
        end += 1
    return text, ""


def _strip_ab(path: str) -> str:
    if path.startswith("a/") or path.startswith("b/"):
        return path[2:]
    return path


def _header_path(line: str) -> str:
    rest = line[4:].split("\t", 1)[0].strip()
    if len(rest) >= 2 and rest[0] == '"' and rest[-1] == '"':
        rest = rest[1:-1]
    return _strip_ab(rest)


def parse_blame(porcelain: str) -> dict[int, int]:
    """A commit printed earlier keeps that time."""
    rows = porcelain.splitlines()
    found: dict[int, int] = {}
    time_of_commit: dict[str, int] = {}
    previous: int | None = None
    index = 0
    while index < len(rows):
        match = _BLAME.match(rows[index])
        if match is None:
            index += 1
            continue
        sha = match.group(1).lstrip("^")
        final = int(match.group(3))
        count = int(match.group(4)) if match.group(4) else 1
        index += 1
        author_time: int | None = None
        while index < len(rows) and not rows[index].startswith("\t") and _BLAME.match(rows[index]) is None:
            if rows[index].startswith("author-time "):
                author_time = int(rows[index].split()[1])
            index += 1
        if index < len(rows) and rows[index].startswith("\t"):
            index += 1
        if author_time is None:
            author_time = time_of_commit.get(sha, previous)
        if author_time is None:
            continue
        time_of_commit[sha] = author_time
        previous = author_time
        for offset in range(count):
            found[final + offset] = author_time
    return found


def _hunk_age(hunk: TextHunk, blame: Mapping[int, int], now: datetime) -> timedelta | None:
    if now.tzinfo is None or now.tzinfo.utcoffset(now) is None:
        raise ValueError("now must be timezone-aware")
    old_no = hunk.old_start
    times: list[float] = []
    for line in hunk.lines:
        if line.kind is Kind.ADDED:
            continue
        if line.kind is Kind.REMOVED:
            stamped = blame.get(old_no)
            times.append(now.timestamp() if stamped is None else stamped)
        old_no += 1
    if not times:
        return None
    age = now - datetime.fromtimestamp(max(times), timezone.utc)
    if age < timedelta(0):
        return timedelta(0)
    return age


def _age_label(age: timedelta | None) -> str:
    if age is None:
        return ""
    seconds = max(0, int(age.total_seconds()))
    if seconds < 3600:
        count, unit = seconds // 60, "minute"
    elif seconds < 86400:
        count, unit = seconds // 3600, "hour"
    else:
        count, unit = seconds // 86400, "day"
    if count == 1:
        return f"1 {unit}"
    return f"{count} {unit}s"


def _change_key(source: str, hunk: TextHunk) -> str:
    parts = [f"{source}\n{hunk.path}\n{hunk.old_start}\n{hunk.new_start}\n"]
    for kind, sigil in ((Kind.REMOVED, "-"), (Kind.ADDED, "+")):
        for line in hunk.lines:
            if line.kind is kind:
                parts.append(f"{sigil}{line.text}\n")
    return hashlib.sha256("".join(parts).encode("utf-8")).hexdigest()[:16]


def _fit(lines: tuple[ShotLine, ...]) -> tuple[ShotLine, ...]:
    clipped = []
    for line in lines:
        text = line.text
        if len(text) > MAX_COLUMNS:
            text = text[: MAX_COLUMNS - 1] + "…"
        clipped.append(ShotLine(text, line.marked))
    if len(clipped) <= MAX_LINES:
        return tuple(clipped)
    hidden = len(clipped) - MAX_LINES
    marker = ShotLine(f"… truncated, {hidden} lines not shown", False)
    return tuple(clipped[:MAX_LINES] + [marker])


def _span(start: int, end: int) -> str:
    return str(start) if start == end else f"{start}-{end}"


def _sides(hunk: TextHunk) -> tuple[tuple[ShotLine, ...], tuple[ShotLine, ...], int, int, str, str]:
    before: list[ShotLine] = []
    after: list[ShotLine] = []
    old_no, new_no = hunk.old_start, hunk.new_start
    old_end = new_end = None
    after_start = 1
    for line in hunk.lines:
        if line.kind is Kind.REMOVED:
            before.append(ShotLine(line.text, True))
            old_end = old_no
            old_no += 1
            continue
        if line.kind is Kind.ADDED:
            if not after:
                after_start = new_no if new_no else 1
            after.append(ShotLine(line.text, True))
            new_end = new_no
            new_no += 1
            continue
        if not after:
            after_start = new_no if new_no else 1
        before.append(ShotLine(line.text, False))
        after.append(ShotLine(line.text, False))
        old_end = old_no
        new_end = new_no
        old_no += 1
        new_no += 1
    before_start = hunk.old_start if before and hunk.old_start else 1
    if not after:
        after = [ShotLine("(deleted)", False)]
        after_start = 1
        after_span = "deleted"
    else:
        after_span = "" if new_end is None else _span(after_start, new_end)
    before_span = "" if old_end is None else _span(before_start, old_end)
    return _fit(tuple(before)), _fit(tuple(after)), before_start, after_start, before_span, after_span


def _ignored(path: str) -> bool:
    name = Path(path).name
    return name in LOCK_NAMES or name.endswith(".lock") or any(path.endswith(suffix) for suffix in SKIP_SUFFIXES)


def _header(path: str, span: str, label: str) -> str:
    lived = f"  ·  lived {label}" if label else ""
    if span == "deleted":
        return f"{path}  deleted{lived}"
    if not span:
        return f"{path}{lived}"
    return f"{path}  lines {span}{lived}"


def _decision(hunk: TextHunk, key: str, age: timedelta | None, commit: str, young: bool = False) -> Decision:
    before, after, before_start, after_start, before_span, after_span = _sides(hunk)
    label = _age_label(age)
    slug = re.sub(r"[^A-Za-z0-9._-]", "_", hunk.path)
    note_span = before_span or after_span
    note = _render_note(commit, hunk.path, note_span, label, key, young)
    return Decision(
        key=key,
        slug=f"{slug}_{hunk.old_start}"[:60],
        path=hunk.path,
        before_header=_header(hunk.path, before_span, label),
        after_header=_header(hunk.path, after_span, label),
        before_lines=before,
        after_lines=after,
        before_start=before_start,
        after_start=after_start,
        note_md=note,
    )


def select_decisions(
    entries: tuple[DiffEntry, ...],
    blame_of: Callable[[str], Mapping[int, int]],
    *,
    source: str,
    commit: str,
    min_age: timedelta | None,
    captured: frozenset[str],
    now: datetime,
    mark_young_below: timedelta | None = None,
) -> tuple[Decision, ...]:
    if now.tzinfo is None or now.tzinfo.utcoffset(now) is None:
        raise ValueError("now must be timezone-aware")
    seen = set(captured)
    chosen: list[Decision] = []
    for entry in entries:
        if not isinstance(entry, TextHunk) or _ignored(entry.path):
            continue
        removed = any(line.kind is Kind.REMOVED for line in entry.lines)
        age = _hunk_age(entry, blame_of(entry.path), now) if removed else None
        if min_age is not None and (age is None or age < min_age):
            continue
        key = _change_key(source, entry)
        if key in seen:
            continue
        seen.add(key)
        young = mark_young_below is not None and age is not None and age < mark_young_below
        chosen.append(_decision(entry, key, age, commit, young))
    return tuple(chosen)


FONT_NAMES = ("DejaVuSansMono.ttf", "LiberationMono-Regular.ttf", "consola.ttf", "Consolas.ttf")


def font_roots() -> tuple[str, ...]:
    roots = ["/usr/share/fonts"]
    windir = os.environ.get("WINDIR")
    if windir:
        roots.append(os.path.join(windir, "Fonts"))
    elif os.name == "nt":
        roots.append(r"C:\Windows\Fonts")
    return tuple(roots)


def find_font(roots: tuple[str, ...]) -> str | None:
    """First monospace file in FONT_NAMES order. DejaVu wins over Consolas."""
    for name in FONT_NAMES:
        for root in roots:
            if not os.path.isdir(root):
                continue
            for dirpath, _dirs, files in os.walk(root):
                if name in files:
                    return os.path.join(dirpath, name)
    return None


def _font(size: int = 18):
    path = find_font(font_roots())
    if path is not None:
        try:
            return ImageFont.truetype(path, size)
        except OSError:
            pass
    return ImageFont.load_default()


def _marker(line: ShotLine) -> bool:
    return line.text.startswith("… truncated, ") and line.text.endswith(" lines not shown")


def render_png(
    lines: tuple[ShotLine, ...],
    header: str,
    lexer_path: str,
    first_line: int,
    dest: Path,
    tint: str,
) -> None:
    font = _font()
    try:
        lexer = get_lexer_for_filename(lexer_path)
    except Exception:
        lexer = TextLexer()
    style = get_style_by_name("default")
    padding, line_height, ink = 20, 26, "#24292f"

    def px(text: str) -> int:
        return math.ceil(font.getlength(text))

    numbered = [line for line in lines if not _marker(line)]
    last_no = first_line + max(len(numbered) - 1, 0)
    gutter = px(str(last_no)) + 16
    longest = max((px(line.text) for line in lines), default=0)
    natural = padding * 2 + max(px(header), gutter + longest)
    cap = padding * 2 + gutter + px("M") * (MAX_COLUMNS + 1)
    width = max(1, min(natural, cap))
    band = line_height + padding
    image = Image.new("RGB", (width, band + line_height * len(lines) + padding), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, width, band), fill="#e7eef6")
    draw.text((padding, (band - line_height) // 2), header, font=font, fill="#1c2834")
    y, number, code_x = band, first_line, padding + gutter
    for line in lines:
        if line.marked:
            draw.rectangle((0, y, width, y + line_height), fill=tint)
        if _marker(line):
            draw.text((code_x, y), line.text, font=font, fill=ink)
        else:
            draw.text((padding, y), str(number), font=font, fill="#8b98a5")
            x = code_x
            for token, value in lex(line.text, lexer):
                value = value.replace("\n", "")
                if value == "":
                    continue
                color = style.style_for_token(token)["color"]
                draw.text((x, y), value, font=font, fill=("#" + color) if color else ink)
                x += px(value)
            number += 1
        y += line_height
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest, format="PNG")


def _git(start: Path, *args: str) -> str:
    cwd = start if args[:2] == ("rev-parse", "--show-toplevel") else _toplevel(start)
    cmd = ["git", "-c", "color.ui=never", "-C", str(cwd), *args]
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
    if proc.returncode != 0:
        if args[:2] == ("config", "--get") and proc.returncode == 1:
            return ""
        raise subprocess.CalledProcessError(proc.returncode, cmd, proc.stdout, proc.stderr)
    return proc.stdout


def _toplevel(start: Path) -> Path:
    return Path(_git(start, "rev-parse", "--show-toplevel").strip())


def _hooks_dir(start: Path) -> Path:
    raw = Path(_git(start, "rev-parse", "--git-path", "hooks").strip())
    return raw if raw.is_absolute() else _toplevel(start) / raw


def _min_age(start: Path) -> timedelta:
    raw = _git(start, "config", "--get", "decap.minAge")
    if raw == "":
        return DEFAULT_MIN_AGE
    text = raw.strip()
    try:
        hours = float(text)
    except ValueError:
        hours = None
    if text == "" or hours is None or not math.isfinite(hours) or hours < 0:
        raise ValueError("decap.minAge must be a non-negative number of hours")
    return timedelta(hours=hours)


def _rev_exists(start: Path, rev: str) -> bool:
    try:
        _git(start, "rev-parse", "--verify", rev)
    except subprocess.CalledProcessError:
        return False
    return True


def hook_line(*command: Path) -> str:
    """Shell text Git for Windows and Linux both run. Backslashes become slashes."""
    text = " ".join(shlex.quote(str(part).replace("\\", "/")) for part in command)
    return f"{text} hook || true"


def install_hook(start: Path, *command: Path) -> str:
    hook = _hooks_dir(start) / "post-commit"
    line = hook_line(*command).encode()
    block = f"{BEGIN}\n".encode() + line + f"\n{END}\n".encode()
    if not hook.exists():
        hook.parent.mkdir(parents=True, exist_ok=True)
        hook.write_bytes(b"#!/bin/sh\n" + block)
        os.chmod(hook, 0o755)
        return "created"
    data = hook.read_bytes()
    at = data.find(BEGIN.encode())
    if at == -1:
        if data and not data.endswith(b"\n"):
            data += b"\n"
        hook.write_bytes(data + block)
        os.chmod(hook, 0o755)
        return "appended"
    stop = data.find(END.encode(), at + len(BEGIN))
    if stop == -1:
        raise ValueError("post-commit has a decap begin marker and no end marker")
    if data[at + len(BEGIN):stop].strip(b"\r\n") == line:
        return "unchanged"
    hook.write_bytes(data[: at + len(BEGIN)] + b"\n" + line + b"\n" + data[stop:])
    os.chmod(hook, 0o755)
    return "updated"


def resolve_decap(raw: str, found: str | None) -> Path:
    if os.sep in raw or (os.altsep is not None and os.altsep in raw):
        path = Path(raw)
    else:
        path = Path(found) if found else Path(raw)
    path = path.resolve()
    if path.exists():
        return path
    if path.suffix.lower() != ".exe":
        exe = Path(str(path) + ".exe")
        if exe.exists():
            return exe
    raise FileNotFoundError(path)


def decap_executable() -> Path:
    found = None if (os.sep in sys.argv[0] or (os.altsep is not None and os.altsep in sys.argv[0])) else shutil.which("decap")
    return resolve_decap(sys.argv[0], found)


def _captured(top: Path) -> frozenset[str]:
    root = top / ".decisions"
    if not root.is_dir():
        return frozenset()
    keys: set[str] = set()
    for child in root.iterdir():
        if not child.is_dir() or child.name.startswith("."):
            continue
        note = child / "note.md"
        if note.is_file():
            key = _note_key(note.read_text(encoding="utf-8").replace("\r\n", "\n").replace("\r", "\n"))
            if key:
                keys.add(key)
    return frozenset(keys)


def _render_note(commit: str, file: str, lines: str, age: str, change: str, young: bool = False) -> str:
    title = f"# {file} lines {lines}" if lines else f"# {file}"
    marker = "young: true\n" if young else ""
    return (
        f"{title}\n\n"
        "![before](before.png)\n"
        "![after](after.png)\n\n"
        "<!-- decap\n"
        f"commit: {commit}\n"
        f"file: {file}\n"
        f"lines: {lines}\n"
        f"age: {age}\n"
        f"change: {change}\n"
        f"{marker}"
        "-->\n"
    )


def _note_key(text: str) -> str | None:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    block = None
    if text.startswith("---\n"):
        end = text.find("\n---\n", 3)
        if end >= 0:
            block = text[4:end]
    else:
        start = text.find("<!-- decap\n")
        end = text.find("\n-->", start + 11) if start >= 0 else -1
        if start >= 0 and end >= 0:
            block = text[start + len("<!-- decap\n"):end]
    if block is None:
        return None
    for line in block.split("\n"):
        if line.startswith("change:"):
            value = line.split(":", 1)[1].strip()
            return value or None
    return None


def run(start: Path, source: str, now: datetime | None = None, any_age: bool = False) -> tuple[Path, ...]:
    if now is None:
        now = datetime.now(timezone.utc)
    if now.tzinfo is None or now.tzinfo.utcoffset(now) is None:
        raise ValueError("now must be timezone-aware")
    top = _toplevel(start)
    if source == "commit":
        if _rev_exists(start, "HEAD^2") or not _rev_exists(start, "HEAD^"):
            return ()
        diff = _diff(start, "HEAD^", "HEAD")
        gate = _min_age(start)
        rev, min_age = "HEAD^", (timedelta(0) if any_age else gate)
        mark_young_below = gate if any_age else None
        commit = _git(start, "rev-parse", "HEAD").strip()
    elif source == "worktree":
        diff = _diff(start, "HEAD")
        rev, min_age, commit = "HEAD", None, "uncommitted"
        mark_young_below = None
    else:
        raise ValueError("source must be commit or worktree")
    cache: dict[str, dict[int, int]] = {}

    def blame_of(path: str) -> dict[int, int]:
        if path not in cache:
            try:
                porcelain = _git(start, "blame", "-p", rev, "--", path)
            except subprocess.CalledProcessError:
                porcelain = ""
            cache[path] = parse_blame(porcelain)
        return cache[path]

    chosen = select_decisions(
        parse_diff(diff), blame_of, source=source, commit=commit,
        min_age=min_age, captured=_captured(top), now=now, mark_young_below=mark_young_below,
    )
    if not chosen:
        return ()
    root = top / ".decisions"
    stamp = now.astimezone().strftime("%Y-%m-%d_%H%M%S")
    written: list[Path] = []
    for decision in chosen:
        partial = root / f".partial-{decision.key}"
        if partial.exists():
            shutil.rmtree(partial)
        partial.mkdir(parents=True)
        render_png(
            decision.before_lines, decision.before_header, decision.path,
            decision.before_start, partial / "before.png", "#fde8e8",
        )
        render_png(
            decision.after_lines, decision.after_header, decision.path,
            decision.after_start, partial / "after.png", "#e6f4ea",
        )
        (partial / "note.md").write_text(decision.note_md, encoding="utf-8", newline="\n")
        dest = root / f"{stamp}_{decision.slug}"
        if dest.exists():
            dest = root / f"{stamp}_{decision.slug}_{decision.key[:6]}"
        _publish(partial, dest)
        # A directory rename often does not create a new note.md event for the editor.
        (dest / "note.md").write_text(decision.note_md, encoding="utf-8", newline="\n")
        written.append(dest)
    return tuple(written)


def _diff(start: Path, *revs: str) -> str:
    return _git(
        start, "diff", f"-U{CONTEXT_LINES}", "--no-renames", "--no-ext-diff",
        "--ignore-cr-at-eol", *revs,
    )


def _publish(partial: Path, dest: Path) -> None:
    try:
        os.replace(partial, dest)
    except OSError:
        shutil.move(str(partial), str(dest))


def notify(folders: tuple[Path, ...]) -> None:
    if not folders:
        return
    body = "\n".join(str(folder) for folder in folders)
    if os.name == "nt":
        _notify_windows(body)
        return
    if shutil.which("notify-send") is None:
        return
    try:
        subprocess.run(["notify-send", "decap", body], check=False)
    except OSError:
        return


def _notify_windows(body: str) -> None:
    if shutil.which("powershell") is None:
        return
    script = (
        "$body = $env:DECAP_NOTIFY\n"
        "try {\n"
        "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null\n"
        "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null\n"
        "  $safe = [System.Security.SecurityElement]::Escape($body)\n"
        "  $xml = \"<toast><visual><binding template='ToastText02'><text id='1'>decap</text><text id='2'>\" + $safe + \"</text></binding></visual></toast>\"\n"
        "  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument\n"
        "  $doc.LoadXml($xml)\n"
        "  $toast = [Windows.UI.Notifications.ToastNotification]::new($doc)\n"
        "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('decap').Show($toast)\n"
        "} catch { exit 0 }\n"
    )
    env = os.environ.copy()
    env["DECAP_NOTIFY"] = body
    try:
        subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            env=env, check=False, timeout=8, capture_output=True,
        )
    except (OSError, subprocess.TimeoutExpired):
        return


def _git_message(err: subprocess.CalledProcessError) -> str:
    text = (err.stderr or "").strip()
    return text or "git command failed"


def _parse(argv: list[str]) -> tuple[str, tuple[Path, ...] | None, bool] | None:
    any_age = "--any-age" in argv
    argv = [arg for arg in argv if arg != "--any-age"]
    if argv == ["install"]:
        return ("install", None, False)
    if len(argv) == 5 and argv[0] == "install" and argv[1] == "--python" and argv[3] == "--script":
        return ("install", (Path(argv[2]), Path(argv[4])), False)
    if len(argv) == 1 and argv[0] in ("snap", "hook"):
        return (argv[0], None, any_age)
    return None


def main(argv: list[str] | None = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    parsed = _parse(argv)
    if parsed is None:
        print("usage: decap install [--python PATH --script PATH] | snap [--any-age] | hook [--any-age]", file=sys.stderr)
        return 2
    start = Path.cwd()
    command, runtime, any_age = parsed
    if command == "install":
        try:
            if runtime is None:
                parts: tuple[Path, ...] = (decap_executable(),)
            else:
                python, script = runtime
                if not python.is_file() or not script.is_file():
                    missing = python if not python.is_file() else script
                    raise FileNotFoundError(missing)
                parts = runtime
            action = install_hook(start, *parts)
            print(f"decap: {action} {_hooks_dir(start) / 'post-commit'}")
        except subprocess.CalledProcessError as err:
            print(f"decap: {_git_message(err)}", file=sys.stderr)
            return 1
        except (ValueError, FileNotFoundError) as err:
            print(f"decap: {err}", file=sys.stderr)
            return 1
        return 0
    source = "worktree" if command == "snap" else "commit"
    try:
        folders = run(start, source, any_age=any_age)
        notify(folders)
        for folder in folders:
            print(folder)
    except subprocess.CalledProcessError as err:
        print(f"decap: {_git_message(err)}", file=sys.stderr)
        return 0 if command == "hook" else 1
    except Exception as err:
        if command != "hook":
            raise
        print(f"decap: {err}", file=sys.stderr)
        return 0
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
