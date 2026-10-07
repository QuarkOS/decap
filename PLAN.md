# decap: decision-capture tool plan (2026-10-07, Lauren)

Plan only; nothing built.

## Shape chosen
Compared: (a) periodic screenshots, rejected as noise; (b) background file-watcher tracking per-line age, rejected as complex and stateful; (c) git post-commit hook + `git blame`, chosen. No daemon, DB, or server; a commit is where a decision lands.

## MVP
- `decap install`: writes a post-commit hook.
- Hook: for changed/deleted lines in the commit, `git blame` on the parent gives the last-touched time; if >= 12h old (`git config decap.minAge`), save before/after.
- `decap snap`: manual; working tree vs HEAD; bound to a KDE/Nobara global shortcut (no key-listener code).
- Skips: new files, merges, lockfiles/binaries, commits already captured (amend-safe).

## Rendered image
Not an editor screenshot. The tool draws the hunk text as a syntax-highlighted PNG. before.png = old lines + 3 context, after.png = new lines. Header: path, line range, survival age ("lived 3 days"). Hunks over ~60 lines are truncated with a marker. Survives history rewrites and lost code.

## Notes
`.decisions/<date>_<time>_<slug>/` with before.png, after.png, note.md (front matter: commit, file, lines, age; empty "Why:"). A desktop notification gives the path. Backed up with the repo (GitHub + USB).

## Stack
Python 3 CLI via pipx; Pygments + Pillow. No hosting.

## Out
Periodic and UI screenshots, web gallery, DB, hosting/sync, AI explanations, editor plugin, Windows/macOS, config file, notes editor UI, auto-posting to X.

## Milestones
1. Spike: draw one hard-coded hunk to PNG.
2. `snap`: parse git diff into hunks, write images + note.md.
3. Blame age filter + `install` + hook.
4. One week of use on the Diplomprojekt; fix only what hurts.
5. Later, optional: side-by-side image for X; package for others.

## Hand-code
Nearly all of it (~300 lines). Best for learning: diff parsing, blame/age logic, Pygments/Pillow rendering. Use AI for review and getting unstuck.

## Open
Whether `.decisions/` is committed to the shared repo; decide with the partner.
