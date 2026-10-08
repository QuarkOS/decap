# Changelog

## 0.1.4

A commit younger than 12 hours still stays out of `.decisions` until you ask. The notification says how old the lines are and offers Review anyway, every time. The status bar message stays, and clicking it reviews that commit too. Review anyway writes the usual images and note, shows the real age, marks the note `young: true`, and opens Fill in why. The same change is not written again by a later capture or by the hook. `decap: Review last commit` reviews HEAD even when the lines are already old enough, and it says when there is nothing to review. `decap hook --any-age` does the same capture from the command line.

## 0.1.3

Fill in why opens a form in the editor. The form shows the file and lines, the age, a short commit hash, the before and after images, and a text box that is focused immediately. Save keeps the reason and moves to the next capture that still needs one. Closing the form leaves the reason empty. `note.md` now reads as a heading, the reason, and the two images. The commit, file, lines, age, and change hash sit in an HTML comment so a Markdown preview does not turn them into a giant heading. Notes written by 0.1.0 through 0.1.2 still count as the same capture.

## 0.1.2

The sidebar reads `.decisions` from the git repository, including a repository one folder below the folder you opened. Fill in why opens that note, and a status item stays until the Why line has text. A commit that changes only new lines, or only lines younger than 12 hours, says so in the status bar. The first too-new commit explains the 12 hour rule and `git config decap.minAge 0`. `decap: Show log` opens the output channel that records each commit.

## 0.1.1

The editor captures by itself. Installing the extension is the whole setup. It watches new commits while the window is open, writes the same `.decisions` folders as the command-line tool, and does not need Python or a git hook. A new capture offers Fill in why. Commits made while the editor is closed are not captured. The command-line tool and its hook remain available for terminal-only use.

## 0.1.0

First release. The extension offers to install the decap command and the post-commit hook, captures the working tree with Alt+Shift+S, and lists each capture in the sidebar with the before and after images side by side.
