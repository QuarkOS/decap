import os
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path

from PIL import Image

from decap import (
    Kind,
    Line,
    NewFile,
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
        "---\n"
        "commit: abc123\n"
        "file: src/app.py\n"
        "lines: 10-12\n"
        "age: 2 days\n"
        f"change: {decision.key}\n"
        "---\n"
        "\n"
        "Why:\n"
    )
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
    assert "Why:" in note.splitlines()
    assert run(repo, "commit") == ()


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


def test_notify_on_windows_uses_powershell_or_skips(monkeypatch, tmp_path):
    monkeypatch.setattr("decap.os.name", "nt")
    monkeypatch.setattr("decap.shutil.which", lambda name: "powershell.exe" if name == "powershell" else None)
    called = []
    monkeypatch.setattr("decap.subprocess.run", lambda *args, **_kwargs: called.append(args[0]))
    notify((tmp_path,))
    assert called[0][:4] == ["powershell", "-NoProfile", "-NonInteractive", "-Command"]
    assert "notify-send" not in called[0]
