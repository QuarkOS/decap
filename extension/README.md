# decap

decap saves a before image and an after image when a commit changes a line that last changed hours ago. Each capture is a folder with those images and a note where you write why.

## Requirements

Git. The extension does not need Python. On Windows, install Git for Windows. Commits made while the editor is closed are not captured.

The command-line tool in this repository is separate. It needs Python 3.11 or newer and a post-commit hook. Use it when you want captures from a terminal with no editor open.

## First run

Install the extension and open a git repository. There is no setup step. The next commit that changes a line at least 12 hours old is saved under `.decisions`.

## Commands

`decap: Snap` captures the working tree against HEAD, including lines younger than 12 hours. The default key is Alt+Shift+S.

`decap: Open decisions` opens the sidebar.

## Sidebar

The Decisions view lists `.decisions` folders, newest first. Before any capture it explains that a capture appears after you commit a change to an old line. Select one to see the before image and the after image side by side, with the note under them. Edit the Why box and leave the field to save `note.md`.

A new capture shows a notification with Fill in why. That opens the sidebar on the new note and focuses the Why box.

Images use DejaVu Sans Mono, which is bundled with the extension. DejaVu is based on Bitstream Vera. The font license is `media/DejaVu-LICENSE.txt`.
