import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image

from decap import (
    _body_key,
    _change_key,
    _parse_saved,
    _render_saved,
    Kind,
    Line,
    NewFile,
    SavedWhy,
    ShotLine,
    TextHunk,
    find_font,
    hook_line,
    install_hook,
    notify,
    resolve_decap,
    parse_diff,
    render_png,
    run,
    select_decisions,
    _note_key,
    _parse,
)

ONE_HUNK = (
    "diff --git a/src/app.py b/src/app.py\n"
    "index 1111111..2222222 100644\n"
    "--- a/src/app.py\n"
    "+++ b/src/app.py\n"
    "@@ -10,3 +10,3 @@\n"
    " keep\n"
    "-old\n"
    "+new\n"
    " tail\n"
)

NEW_FILE = (
    "diff --git a/src/new.py b/src/new.py\n"
    "new file mode 100644\n"
    "index 0000000..1111111\n"
    "--- /dev/null\n"
    "+++ b/src/new.py\n"
    "@@ -0,0 +1 @@\n"
    "+hello\n"
)


def git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "config", "user.email", "dev@example.com"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Dev"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    subprocess.run(
        ["git", "config", "core.autocrlf", "false"],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
    )
    return repo


def commit(repo: Path, hours_ago: float, message: str) -> None:
    when = datetime.now(timezone.utc) - timedelta(hours=hours_ago)
    stamp = when.replace(microsecond=0).isoformat()
    env = os.environ.copy()
    env["GIT_AUTHOR_DATE"] = stamp
    env["GIT_COMMITTER_DATE"] = stamp
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True, text=True)
    subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "commit", "-m", message],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        env=env,
    )


def test_parse_diff_reads_one_hunk():
    entries = parse_diff(ONE_HUNK)
    assert entries == (
        TextHunk(
            "src/app.py",
            10,
            10,
            (
                Line(Kind.CONTEXT, "keep"),
                Line(Kind.REMOVED, "old"),
                Line(Kind.ADDED, "new"),
                Line(Kind.CONTEXT, "tail"),
            ),
        ),
    )


def test_parse_diff_skips_new_file():
    entries = parse_diff(NEW_FILE)
    assert entries == (NewFile("src/new.py"),)
    assert not any(isinstance(entry, TextHunk) for entry in entries)


def test_note_and_age_gate():
    hunk = TextHunk(
        "src/app.py",
        10,
        10,
        (
            Line(Kind.CONTEXT, "keep"),
            Line(Kind.REMOVED, "old"),
            Line(Kind.ADDED, "new"),
            Line(Kind.CONTEXT, "tail"),
        ),
    )
    now = datetime(2026, 10, 7, tzinfo=timezone.utc)
    old = {11: int((now - timedelta(hours=48)).timestamp())}

    def blame_of(_path: str) -> dict[int, int]:
        return old

    chosen = select_decisions(
        (hunk,),
        blame_of,
        source="commit",
        commit="abc123",
        min_age=timedelta(hours=12),
        captured=frozenset(),
        now=now,
    )
    assert len(chosen) == 1
    decision = chosen[0]
    assert decision.note_md == (
        "# src/app.py lines 10-12\n"
        "\n"
        "![before](before.png)\n"
        "![after](after.png)\n"
        "\n"
        "<!-- decap\n"
        "commit: abc123\n"
        "file: src/app.py\n"
        "lines: 10-12\n"
        "age: 2 days\n"
        f"change: {decision.key}\n"
        "-->\n"
    )
    assert not decision.note_md.startswith("---")
    visible = decision.note_md.split("<!--", 1)[0]
    assert "commit:" not in visible
    assert "change:" not in visible
    assert [(line.text, line.marked) for line in decision.before_lines] == [
        ("keep", False),
        ("old", True),
        ("tail", False),
    ]
    assert [(line.text, line.marked) for line in decision.after_lines] == [
        ("keep", False),
        ("new", True),
        ("tail", False),
    ]
    assert decision.before_header == "src/app.py  lines 10-12  ·  lived 2 days"
    assert decision.after_header == "src/app.py  lines 10-12  ·  lived 2 days"

    young = {11: int((now - timedelta(hours=1)).timestamp())}

    def young_blame(_path: str) -> dict[int, int]:
        return young

    assert (
        select_decisions(
            (hunk,),
            young_blame,
            source="commit",
            commit="abc123",
            min_age=timedelta(hours=12),
            captured=frozenset(),
            now=now,
        )
        == ()
    )
    equal = select_decisions(
        (hunk,),
        blame_of,
        source="commit",
        commit="abc123",
        min_age=timedelta(hours=48),
        captured=frozenset(),
        now=now,
    )
    assert len(equal) == 1

    fresh = {11: int((now - timedelta(seconds=10)).timestamp())}

    def fresh_blame(_path: str) -> dict[int, int]:
        return fresh

    recent = select_decisions(
        (hunk,),
        fresh_blame,
        source="commit",
        commit="abc123",
        min_age=timedelta(0),
        captured=frozenset(),
        now=now,
    )
    assert len(recent) == 1
    assert recent[0].before_header.endswith("lived less than a minute")
    assert recent[0].after_header.endswith("lived less than a minute")
    assert "age: less than a minute" in recent[0].note_md.splitlines()
    assert "0 minutes" not in recent[0].note_md


def test_install_hook_keeps_existing_hook(tmp_path):
    repo = git_repo(tmp_path)
    hook = repo / ".git" / "hooks" / "post-commit"
    hook.write_text("#!/bin/sh\necho hello\n", newline="\n")
    hook.chmod(0o755)
    assert install_hook(repo, Path("/usr/bin/decap")) == "appended"
    text = hook.read_text()
    assert text.startswith("#!/bin/sh\necho hello\n")
    assert text.count("# decap: begin") == 1
    assert "/usr/bin/decap hook || true" in text.splitlines()
    before = hook.read_bytes()
    assert install_hook(repo, Path("/usr/bin/decap")) == "unchanged"
    assert hook.read_bytes() == before


def _app(repo: Path, text: str) -> None:
    path = repo / "src" / "app.py"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, newline="\n")


def test_old_line_commit_writes_pngs(tmp_path):
    repo = git_repo(tmp_path)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 48, "start")
    _app(repo, "keep\nnew\ntail\n")
    commit(repo, 0, "edit")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()
    folders = run(repo, "commit")
    assert len(folders) == 1
    folder = folders[0]
    for name in ("before.png", "after.png"):
        data = (folder / name).read_bytes()
        assert data.startswith(b"\x89PNG")
        assert len(data) > 500
    note = (folder / "note.md").read_text()
    assert f"commit: {head}" in note.splitlines()
    assert "file: src/app.py" in note.splitlines()
    assert note.startswith("# src/app.py")
    assert "![before](before.png)" in note.splitlines()
    assert "![after](after.png)" in note.splitlines()
    assert not note.startswith("---")
    assert run(repo, "commit") == ()


def test_legacy_note_keeps_the_change_key(tmp_path):
    repo = git_repo(tmp_path)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 48, "start")
    _app(repo, "keep\nnew\ntail\n")
    commit(repo, 0, "edit")
    folders = run(repo, "commit")
    note_path = folders[0] / "note.md"
    key = _note_key(note_path.read_text())
    assert key
    legacy = (
        "---\n"
        "commit: abc\n"
        "file: src/app.py\n"
        "lines: 1-3\n"
        "age: 2 days\n"
        f"change: {key}\n"
        "---\n"
        "\n"
        "Why:\n"
    )
    assert _note_key(legacy) == key
    note_path.write_text(legacy, newline="\n")
    assert run(repo, "commit") == ()


def test_any_age_marks_a_young_line_once(tmp_path):
    repo = git_repo(tmp_path)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 1, "start")
    _app(repo, "keep\nnew\ntail\n")
    commit(repo, 0, "edit")
    assert run(repo, "commit") == ()
    folders = run(repo, "commit", any_age=True)
    assert len(folders) == 1
    note = (folders[0] / "note.md").read_text()
    assert "young: true" in note.splitlines()
    assert "age: 1 hour" in note.splitlines()
    assert run(repo, "commit") == ()
    assert run(repo, "commit", any_age=True) == ()


def test_any_age_leaves_an_old_line_unmarked(tmp_path):
    repo = git_repo(tmp_path)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 48, "start")
    _app(repo, "keep\nnew\ntail\n")
    commit(repo, 0, "edit")
    folders = run(repo, "commit", any_age=True)
    assert len(folders) == 1
    note = (folders[0] / "note.md").read_text()
    assert "young: true" not in note
    assert "age: 2 days" in note.splitlines()
    assert run(repo, "commit") == ()


def test_parse_any_age_flag():
    assert _parse(["hook", "--any-age"]) == ("hook", None, True)
    assert _parse(["--any-age", "snap"]) == ("snap", None, True)
    assert _parse(["hook"]) == ("hook", None, False)
    assert _parse(["install"]) == ("install", None, False)
    assert _parse(["nope"]) is None


def test_fresh_line_commit_writes_nothing(tmp_path):
    repo = git_repo(tmp_path)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 1, "start")
    _app(repo, "keep\nnew\ntail\n")
    commit(repo, 0, "edit")
    assert run(repo, "commit") == ()
    decisions = repo / ".decisions"
    if decisions.exists():
        captures = [path for path in decisions.iterdir() if path.is_dir() and not path.name.startswith(".")]
        assert captures == []


def test_snap_writes_without_age_gate(tmp_path):
    repo = git_repo(tmp_path)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 1, "start")
    _app(repo, "keep\nnew\ntail\n")
    folders = run(repo, "worktree")
    assert len(folders) == 1
    note = (folders[0] / "note.md").read_text()
    assert "commit: uncommitted" in note.splitlines()


def test_min_age_config(tmp_path):
    repo = git_repo(tmp_path)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 48, "start")
    _app(repo, "keep\nnew\ntail\n")
    commit(repo, 0, "edit")
    subprocess.run(["git", "config", "decap.minAge", "1000"], cwd=repo, check=True)
    assert run(repo, "commit") == ()


def test_both_sides_keep_the_same_context(tmp_path):
    hunk = TextHunk(
        "src/total.py",
        1,
        1,
        (
            Line(Kind.CONTEXT, "def total(xs):"),
            Line(Kind.REMOVED, "    s = 0"),
            Line(Kind.REMOVED, "    for x in xs:"),
            Line(Kind.REMOVED, "        s += x"),
            Line(Kind.REMOVED, "    return s"),
            Line(Kind.ADDED, "    return sum(xs)"),
        ),
    )
    now = datetime(2026, 10, 7, tzinfo=timezone.utc)
    blame = {
        line: int((now - timedelta(hours=48)).timestamp())
        for line in (2, 3, 4, 5)
    }
    decision = select_decisions(
        (hunk,),
        lambda _path: blame,
        source="commit",
        commit="abc123",
        min_age=timedelta(hours=12),
        captured=frozenset(),
        now=now,
    )[0]
    assert decision.before_start == 1
    assert decision.after_start == 1
    assert [(line.text, line.marked) for line in decision.before_lines] == [
        ("def total(xs):", False),
        ("    s = 0", True),
        ("    for x in xs:", True),
        ("        s += x", True),
        ("    return s", True),
    ]
    assert [(line.text, line.marked) for line in decision.after_lines] == [
        ("def total(xs):", False),
        ("    return sum(xs)", True),
    ]
    assert decision.before_header == "src/total.py  lines 1-5  ·  lived 2 days"
    assert decision.after_header == "src/total.py  lines 1-2  ·  lived 2 days"
    before = tmp_path / "before.png"
    after = tmp_path / "after.png"
    render_png(
        decision.before_lines, decision.before_header, decision.path,
        decision.before_start, before, "#fde8e8",
    )
    render_png(
        decision.after_lines, decision.after_header, decision.path,
        decision.after_start, after, "#e6f4ea",
    )
    before_colors = set(Image.open(before).convert("RGB").get_flattened_data())
    after_colors = set(Image.open(after).convert("RGB").get_flattened_data())
    assert (253, 232, 232) in before_colors
    assert (253, 232, 232) not in after_colors
    assert (230, 244, 234) in after_colors
    assert (230, 244, 234) not in before_colors


def test_render_png_is_a_real_image(tmp_path):
    dest = tmp_path / "out" / "before.png"
    render_png(
        (ShotLine("keep", False), ShotLine("old", True)),
        "src/app.py  lines 10-11  ·  lived 2 days",
        "src/app.py",
        10,
        dest,
        "#fde8e8",
    )
    with Image.open(dest) as image:
        assert image.format == "PNG"
        assert image.width > 80
        assert image.height > 40


def test_resolve_decap_appends_exe_when_the_launcher_omits_it(tmp_path):
    scripts = tmp_path / "Scripts"
    scripts.mkdir()
    exe = scripts / "decap.exe"
    exe.write_bytes(b"")
    found = resolve_decap(str(scripts / "decap"), None)
    assert found == exe.resolve()


def test_hook_line_uses_forward_slashes():
    plain = hook_line(Path("C:\\Users\\Ada\\decap.exe"))
    assert plain == "C:/Users/Ada/decap.exe hook || true"
    quoted = hook_line(Path("C:\\Users\\Ada Smith\\decap.exe"))
    assert quoted == "'C:/Users/Ada Smith/decap.exe' hook || true"


def test_change_key_matches_the_editor_fixture():
    app = TextHunk(
        "src/app.py",
        1,
        1,
        (
            Line(Kind.CONTEXT, "def total(xs):"),
            Line(Kind.REMOVED, "    s = 0"),
            Line(Kind.REMOVED, "    return s"),
            Line(Kind.ADDED, "    return sum(xs)"),
        ),
    )
    old = TextHunk(
        "src/old.py",
        1,
        1,
        (
            Line(Kind.CONTEXT, "def keep():"),
            Line(Kind.REMOVED, "    value = 1"),
            Line(Kind.REMOVED, "    return value"),
            Line(Kind.ADDED, "    return 2"),
        ),
    )
    assert _change_key("commit", app) == "2dd27812f1692903"
    assert _change_key("commit", old) == "9d1dde00241324bf"
    moved = TextHunk("src/app.py", 4, 4, app.lines)
    assert _body_key(app) == _body_key(moved) == "fb345a99bdb210f6"
    assert _change_key("commit", moved) != "2dd27812f1692903"
    assert _body_key(old) == "ebdcc043758d305e"


def test_hook_line_quotes_python_and_the_script():
    line = hook_line(
        Path("C:/Program Files/Python312/python.exe"),
        Path("C:/ext/decap.py"),
    )
    assert line == "'C:/Program Files/Python312/python.exe' C:/ext/decap.py hook || true"


def test_install_with_python_and_script(tmp_path, monkeypatch):
    from decap import main

    repo = git_repo(tmp_path)
    monkeypatch.chdir(repo)
    python = tmp_path / "Python312" / "python.exe"
    python.parent.mkdir()
    python.write_bytes(b"")
    script = tmp_path / "bundled" / "decap.py"
    script.parent.mkdir()
    script.write_bytes(b"")
    assert main(["install", "--python", str(python), "--script", str(script)]) == 0
    text = (repo / ".git" / "hooks" / "post-commit").read_text(encoding="utf-8").replace("\\", "/")
    assert "# decap: begin" in text
    assert str(python).replace("\\", "/") in text
    assert str(script).replace("\\", "/") in text


def test_parse_diff_drops_carriage_returns():
    text = ONE_HUNK.replace("\n", "\r\n")
    entries = parse_diff(text)
    assert entries == parse_diff(ONE_HUNK)


def test_crlf_rewrite_is_not_a_capture(tmp_path):
    repo = git_repo(tmp_path)
    subprocess.run(["git", "config", "core.autocrlf", "false"], cwd=repo, check=True)
    _app(repo, "keep\nold\ntail\n")
    commit(repo, 1, "start")
    (repo / "src" / "app.py").write_bytes(b"keep\r\nold\r\ntail\r\n")
    assert run(repo, "worktree") == ()


def test_find_font_prefers_dejavu_then_consolas(tmp_path):
    fonts = tmp_path / "Fonts"
    fonts.mkdir()
    (fonts / "consola.ttf").write_bytes(b"consolas")
    assert find_font((str(fonts),)) == str(fonts / "consola.ttf")
    share = tmp_path / "share"
    share.mkdir()
    (share / "DejaVuSansMono.ttf").write_bytes(b"dejavu")
    assert find_font((str(fonts), str(share))) == str(share / "DejaVuSansMono.ttf")


def test_notify_on_linux_skips_a_missing_notify_send(monkeypatch, tmp_path):
    monkeypatch.setattr("decap.os.name", "posix")
    monkeypatch.setattr("decap.shutil.which", lambda _name: None)
    called = []
    monkeypatch.setattr("decap.subprocess.run", lambda *args, **_kwargs: called.append(args))
    notify((tmp_path,))
    assert called == []


def _decision_dirs(repo: Path) -> list[Path]:
    root = repo / ".decisions"
    if not root.is_dir():
        return []
    return sorted(path for path in root.iterdir() if path.is_dir() and not path.name.startswith("."))


def _head(repo: Path) -> str:
    return subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip()


def _why_repo(tmp_path: Path) -> tuple[Path, Path, str]:
    repo = git_repo(tmp_path)
    _app(repo, "def total(xs):\n    s = 0\n    return s\n")
    commit(repo, 48, "start")
    _app(repo, "def total(xs):\n    return sum(xs)\n")
    commit(repo, 0.5, "use sum")
    folders = run(repo, "commit")
    assert len(folders) == 1
    note = folders[0] / "note.md"
    text = note.read_text(encoding="utf-8")
    assert text.startswith("# src/app.py lines 1-3\n\n")
    text = text.replace("# src/app.py lines 1-3\n\n", "# src/app.py lines 1-3\n\nThe sum was wrong.\n\n", 1)
    note.write_text(text, encoding="utf-8", newline="\n")
    return repo, note, _head(repo)


def _install_real_hook(repo: Path) -> None:
    import decap

    install_hook(repo, Path(sys.executable), Path(decap.__file__))


def _shift_base(repo: Path) -> None:
    subprocess.run(["git", "branch", "shifted", "HEAD~1"], cwd=repo, check=True)
    subprocess.run(["git", "checkout", "shifted"], cwd=repo, check=True)
    _app(repo, "# shifted\n# so the\n# same edit\n# moves\n\ndef total(xs):\n    s = 0\n    return s\n")
    commit(repo, 48, "prefix")
    subprocess.run(["git", "checkout", "-"], cwd=repo, check=True)


def test_saved_why_round_trip_keeps_legacy_and_readable():
    legacy = _parse_saved(
        "---\ncommit: abc123\nfile: src/app.py\nlines: 1-3\nage: 2 days\nchange: abcdef\n---\n\nWhy:\nThe sum was wrong.\n"
    )
    assert legacy.format == "legacy"
    assert legacy.why == "The sum was wrong."
    rendered = _render_saved(SavedWhy(
        folder=None, format="legacy", commit="fff", file=legacy.file, lines="4-8",
        age=legacy.age, change="bbbb", young=False, why=legacy.why, text="",
    ))
    assert rendered.startswith("---\n")
    assert _parse_saved(rendered).why == "The sum was wrong."
    assert "commit: fff" in rendered.splitlines()
    assert "lines: 4-8" in rendered.splitlines()
    readable = _parse_saved(
        "# src/app.py lines 1-3\n\nThe sum was wrong.\n\n"
        "![before](before.png)\n![after](after.png)\n\n"
        "<!-- decap\ncommit: abc123\nfile: src/app.py\nlines: 1-3\nage: 2 days\nchange: abcdef\nyoung: true\n-->\n"
    )
    assert readable.young is True
    again = _render_saved(readable)
    assert _parse_saved(again).why == "The sum was wrong."
    assert "young: true" in again.splitlines()


def test_rebase_that_keeps_lines_points_the_note_at_the_new_commit(tmp_path):
    repo, note, old = _why_repo(tmp_path)
    _install_real_hook(repo)
    subprocess.run(["git", "rebase", "-f", "HEAD~1"], cwd=repo, check=True, capture_output=True, text=True)
    new = _head(repo)
    assert new != old
    text = note.read_text(encoding="utf-8")
    assert "The sum was wrong." in text
    assert f"commit: {new}" in text.splitlines()
    assert old not in text
    assert "lines: 1-3" in text.splitlines()
    assert _note_key(text) == "2dd27812f1692903"
    assert len(_decision_dirs(repo)) == 1
    kept = note.read_text(encoding="utf-8")
    assert run(repo, "commit") == ()
    assert note.read_text(encoding="utf-8") == kept
    assert len(_decision_dirs(repo)) == 1


def test_rebase_that_moves_lines_keeps_one_legacy_why(tmp_path):
    repo, note, old = _why_repo(tmp_path)
    key = _note_key(note.read_text(encoding="utf-8"))
    assert key
    images = {name: (note.parent / name).read_bytes() for name in ("before.png", "after.png")}
    note.write_text(
        "---\n"
        f"commit: {old}\n"
        "file: src/app.py\n"
        "lines: 1-3\n"
        "age: 2 days\n"
        f"change: {key}\n"
        "---\n"
        "\n"
        "Why:\n"
        "The sum was wrong.\n",
        encoding="utf-8",
        newline="\n",
    )
    _shift_base(repo)
    _install_real_hook(repo)
    subprocess.run(["git", "rebase", "shifted"], cwd=repo, check=True, capture_output=True, text=True)
    new = _head(repo)
    assert new != old
    text = note.read_text(encoding="utf-8")
    assert text.startswith("---\n")
    assert "The sum was wrong." in text
    assert f"commit: {new}" in text.splitlines()
    assert old not in text
    assert "lines: 4-8" in text.splitlines()
    assert _note_key(text) != key
    assert len(_decision_dirs(repo)) == 1
    for name, data in images.items():
        assert (note.parent / name).read_bytes() == data
    kept = note.read_text(encoding="utf-8")
    assert run(repo, "commit") == ()
    assert note.read_text(encoding="utf-8") == kept
    assert len(_decision_dirs(repo)) == 1


def test_reapplying_the_same_edit_keeps_the_original_commit(tmp_path):
    repo, note, old = _why_repo(tmp_path)
    _app(repo, "def total(xs):\n    s = 0\n    return s\n")
    commit(repo, 48, "revert")
    _app(repo, "def total(xs):\n    return sum(xs)\n")
    commit(repo, 0, "again")
    assert run(repo, "commit") == ()
    text = note.read_text(encoding="utf-8")
    assert f"commit: {old}" in text.splitlines()
    assert "The sum was wrong." in text
    assert len(_decision_dirs(repo)) == 1


def test_notify_on_windows_uses_powershell_or_skips(monkeypatch, tmp_path):
    monkeypatch.setattr("decap.os.name", "nt")
    monkeypatch.setattr("decap.shutil.which", lambda name: "powershell.exe" if name == "powershell" else None)
    called = []
    monkeypatch.setattr("decap.subprocess.run", lambda *args, **_kwargs: called.append(args[0]))
    notify((tmp_path,))
    assert called[0][:4] == ["powershell", "-NoProfile", "-NonInteractive", "-Command"]
    assert "notify-send" not in called[0]
