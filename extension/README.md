# decap

decap saves a before image and an after image when a commit changes a line that last changed hours ago. Each capture is a folder with those images and a note where you write why.

## Requirements

Python 3.11 or newer, and git. On Windows, install Git for Windows and Python with pipx or pip. On Linux, the same Python and git setup applies. The editor shells out to the `decap` command for every capture.

## First run

Open a git repository. If `decap` is missing, the extension offers to install it. The prompt shows the pipx or pip command before it runs, then shows progress. Errors stay in plain words. If the post-commit hook is missing, the extension offers to install that next. An existing hook is left in place and the decap block is appended.

## Commands

`decap: Snap` captures the working tree against HEAD. The default key is Alt+Shift+S.

`decap: Install hook` writes the post-commit hook.

`decap: Open decisions` opens the sidebar.

## Sidebar

The Decisions view lists `.decisions` folders, newest first. Select one to see the before image and the after image side by side, with the note under them. Edit the Why box and leave the field to save `note.md`.

A new capture shows a notification in the editor.
