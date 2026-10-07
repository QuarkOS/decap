# decap

decap saves a before image and an after image when a commit changes a line that last changed hours ago. Each capture is a folder with those images and a note where you write why.

## Requirements

Python 3.11 or newer, and git. On Windows, install Git for Windows and Python from python.org. On Linux, install the same two. The editor does not need the decap command on PATH. A separate `pipx install` of this repository still works for the command-line tool.

## First run

Open a git repository. The status bar shows Set up decap, and the sidebar explains the same step, until setup finishes. Set up decap creates a private Python environment inside the editor and adds a post-commit hook that calls that environment by its full path. If Python is missing, the message includes a link to install it.

## Commands

`decap: Set up` creates the environment and the hook.

`decap: Snap` captures the working tree against HEAD. The default key is Alt+Shift+S.

`decap: Install hook` runs setup.

`decap: Open decisions` opens the sidebar.

## Sidebar

Until setup finishes, the Decisions view is a welcome page with Set up decap. After that it lists `.decisions` folders, newest first. Select one to see the before image and the after image side by side, with the note under them. Edit the Why box and leave the field to save `note.md`.

A new capture shows a notification with Fill in why. That opens the sidebar on the new note and focuses the Why box.
