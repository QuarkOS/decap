# Changelog

## 0.1.8

Fill in why shows how many reasons are still waiting as soon as the form opens. Saving and moving to the next one closes the notification for the capture you left. The file name is a larger heading. Saved stays on screen long enough to read. The text box focus outline follows the editor theme.

A change the command-line hook already saved still asks for a reason when that reason is empty. Reloading the window brings the fill in why status item back while a reason is missing.

## 0.1.7

The decision list shows the first line of the reason on each row. Typing in the search box keeps rows that match that reason, the file name, or how old the change is.

## 0.1.6

A rebase keeps a reason you already wrote. The note follows the new commit, and decap does not ask for that reason again. The hook and the editor share that note instead of writing a second one. Notes from 0.1.0 through 0.1.5 still open, including a reason already saved.

## 0.1.5

A commit made while the editor is closed is saved when you open the editor again. The changed lines still have to be old enough for the 12 hour rule. A younger line is still skipped, and Review anyway still works. If the command line hook already saved that change, the editor does not write a second note.

## 0.1.4

A commit younger than 12 hours still stays out of `.decisions` until you ask. The notification says how old the lines are and offers Review anyway. An age under a minute reads less than a minute, including on the images and the form. The status bar uses that same short sentence, and clicking it reviews the commit. Review anyway writes the usual images and note, marks the note `young: true`, and opens Fill in why without a second notification, so the text box keeps the keyboard. A change that was already reviewed does not offer Review anyway again. A later click opens the form that is already there. The same change is not written again by a later capture or by the hook. `decap: Review last commit` reviews HEAD even when the lines are already old enough, and it says when there is nothing to review. `decap hook --any-age` does the same capture from the command line.

## 0.1.3

Fill in why opens a form in the editor. The form shows the file and lines, the age, a short commit hash, the before and after images, and a text box that is focused immediately. Save keeps the reason and moves to the next capture that still needs one. Closing the form leaves the reason empty. `note.md` now reads as a heading, the reason, and the two images. The commit, file, lines, age, and change hash sit in an HTML comment so a Markdown preview does not turn them into a giant heading. Notes written by 0.1.0 through 0.1.2 still count as the same capture.

## 0.1.2

The sidebar reads `.decisions` from the git repository, including a repository one folder below the folder you opened. Fill in why opens that note, and a status item stays until the Why line has text. A commit that changes only new lines, or only lines younger than 12 hours, says so in the status bar. The first too-new commit explains the 12 hour rule and `git config decap.minAge 0`. `decap: Show log` opens the output channel that records each commit.

## 0.1.1

The editor captures by itself. Installing the extension is the whole setup. It watches new commits while the window is open, writes the same `.decisions` folders as the command-line tool, and does not need Python or a git hook. A new capture offers Fill in why. Commits made while the editor is closed are not captured. The command-line tool and its hook remain available for terminal-only use.

## 0.1.0

First release. The extension offers to install the decap command and the post-commit hook, captures the working tree with Alt+Shift+S, and lists each capture in the sidebar with the before and after images side by side.
