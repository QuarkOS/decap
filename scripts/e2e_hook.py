"""Install decap, commit an old line through the real hook, then a fresh line.

The decap command must already be on PATH. Git author and committer dates are
set in the past so the 12 hour rule runs against blame, not the wall clock.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> None:
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def commit(repo: Path, hours_ago: float, message: str) -> None:
    when = (datetime.now(timezone.utc) - timedelta(hours=hours_ago)).replace(microsecond=0)
    stamp = when.isoformat()
    env = os.environ.copy()
    env["GIT_AUTHOR_DATE"] = stamp
    env["GIT_COMMITTER_DATE"] = stamp
    run(["git", "add", "-A"], repo)
    run(["git", "-c", "commit.gpgsign=false", "commit", "-m", message], repo, env)


def pngs(repo: Path) -> list[Path]:
    root = repo / ".decisions"
    if not root.is_dir():
        return []
    return [path for path in root.rglob("*.png") if path.is_file() and ".partial" not in path.parts]


def main() -> int:
    if shutil.which("decap") is None:
        print("decap is not on PATH", file=sys.stderr)
        return 1
    repo = Path(tempfile.mkdtemp(prefix="decap-e2e-"))
    run(["git", "init"], repo)
    run(["git", "config", "user.email", "dev@example.com"], repo)
    run(["git", "config", "user.name", "Dev"], repo)
    run(["git", "config", "commit.gpgsign", "false"], repo)
    run(["git", "config", "core.autocrlf", "false"], repo)
    source = repo / "src" / "app.py"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"def total(xs):\n    s = 0\n    return s\n")
    commit(repo, 48, "start")
    run(["decap", "install"], repo)
    source.write_bytes(b"def total(xs):\n    return sum(xs)\n")
    commit(repo, 0, "use sum")
    notes = list((repo / ".decisions").glob("*/note.md")) if (repo / ".decisions").is_dir() else []
    images = pngs(repo)
    if len(notes) != 1 or len(images) < 2:
        print(f"expected one note and two pngs, found notes={len(notes)} pngs={len(images)}", file=sys.stderr)
        return 1
    for image in images:
        data = image.read_bytes()
        if not data.startswith(b"\x89PNG") or len(data) < 500:
            print(f"png too small: {image} {len(data)}", file=sys.stderr)
            return 1
    note = notes[0].read_text(encoding="utf-8")
    if "Why:" not in note.splitlines() or "file: src/app.py" not in note.splitlines():
        print(note, file=sys.stderr)
        return 1
    before = len(notes)
    fresh = repo / "src" / "fresh.py"
    fresh.write_text("def fresh():\n    return 1\n", encoding="utf-8", newline="\n")
    commit(repo, 0, "add fresh")
    after = list((repo / ".decisions").glob("*/note.md"))
    if len(after) != before:
        print(f"fresh commit wrote a capture: {len(after)} notes", file=sys.stderr)
        return 1
    out = Path(os.environ.get("DECAP_E2E_OUT", "e2e-artifacts"))
    out.mkdir(parents=True, exist_ok=True)
    folder = notes[0].parent
    shutil.copy(folder / "before.png", out / "before.png")
    shutil.copy(folder / "after.png", out / "after.png")
    print(f"e2e ok {folder}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
