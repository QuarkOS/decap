# decap

decap saves a before image and an after image when a commit changes a line that last changed hours ago. Each capture is a folder with those images and a note where you write why.

## Requirements

Git. The extension does not need Python. On Windows, install Git for Windows. Commits made while the editor is closed are not captured.

The command-line tool in this repository is separate. It needs Python 3.11 or newer and a post-commit hook. Use it when you want captures from a terminal with no editor open.

## First run

Install the extension and open a folder that contains a git repository. The repository can be that folder, or the folder directly inside it. There is no setup step. The next commit that changes a line at least 12 hours old is saved under `.decisions` in the repository.

## Commands

`decap: Snap` captures the working tree against HEAD, including lines younger than 12 hours. The default key is Alt+Shift+S.

`decap: Open decisions` opens the sidebar.

`decap: Show log` opens the decap output channel. It records each repository and, for every new commit, either the capture or the reason nothing was saved.

`decap: Fill in why` opens the newest note from this session whose Why line is still empty.

## When nothing is captured

A commit that does not change an old line leaves a status bar message for 20 seconds. The message names the reason. A line younger than 12 hours, a commit that only adds lines, a merge, and a change that was already captured each get their own reason. The first time the lines are too new, a notification explains the 12 hour rule and how to set `git config decap.minAge 0` for that repository.

## Sidebar

The Decisions view lists `.decisions` folders from the git repository, newest first. Before any capture it explains that a capture appears after you commit a change to an old line. Select one to see the before image and the after image stacked, with the note under them. Edit the Why box and leave the field to save `note.md`.

A new capture shows a notification with Fill in why. That opens the note in an editor, with the cursor after `Why:`, and selects the capture in the sidebar. The status bar keeps `decap: fill in why` until that note is saved with a reason.

Images use DejaVu Sans Mono, which is bundled with the extension. DejaVu is based on Bitstream Vera. The font license is `media/DejaVu-LICENSE.txt`.
