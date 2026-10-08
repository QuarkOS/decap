# decap

decap saves a before image and an after image when a commit changes a line last touched at least 12 hours ago. Each capture is a folder with those images and a note where you write why the change was made.

## Install

You need Python 3.11+ and git. From a checkout, install decap with pipx.

```
pipx install .
```

## Add the hook

In a repository, run `decap install`.

The command adds a post-commit hook. If a hook file is already there, decap leaves it in place and appends its own block at the end.

The hook captures a commit that changes or deletes a line last touched at least 12 hours ago. `git config decap.minAge 12` sets the hours. The default is 12.

## Snap the working tree

`decap snap` captures the working tree against HEAD. This includes edits younger than the age gate. On Nobara, bind a KDE global shortcut to `decap snap` in the repository directory. decap does not listen for keys.

## Read the capture

decap writes `.decisions/<date>_<time>_<slug>/` with `before.png`, `after.png`, and `note.md`. The note starts with the file and the reason. The change hash is in an HTML comment at the bottom.

On Linux, a notification names the folder when `notify-send` is installed. A missing `notify-send` is skipped. On Windows, decap shows a toast. If the toast cannot be shown, the commit still succeeds and the message is skipped.

## Windows

Install Python 3.11 or newer and Git for Windows. Install decap with pipx or with pip.

```
pipx install .
```

```
python -m pip install --user .
```

`decap install` writes a post-commit hook. Git for Windows runs that hook in its bash. The hook path uses forward slashes so `decap.exe` starts.

A CRLF file is not a change when the text matches the last commit. Images use DejaVu Sans Mono when that font is installed, and Consolas when it is not.

## Editor

The `extension` folder is a VS Code extension. Cursor loads the same package. The Open VSX namespace is `quarkos`. This repository does not publish the package.

From `extension`, install the dependencies and build the package.

```
npm install
npx @vscode/vsce package
```

That writes `decap-0.1.3.vsix`. The CI artifact is the same file.

In VS Code, open Extensions and choose Install from VSIX. From a terminal, run `code --install-extension decap-0.1.3.vsix`.

In Cursor, use the same Install from VSIX action, or run `cursor --install-extension decap-0.1.3.vsix`.

Open a folder that contains a git repository. The repository can be that folder, or the folder directly inside it. Installing the extension is the whole setup. The editor does not need Python and does not install a hook. A commit that changes a line at least 12 hours old is captured while the window is open. Commits made while the editor is closed are not captured. A commit that is too new to capture says so in the status bar. `decap: Show log` opens the output channel. `pipx install .` from a checkout still installs the command-line tool for terminal-only use.

`decap: Snap` captures the working tree. The default key is Alt+Shift+S. `decap: Open decisions` focuses the sidebar.

The sidebar lists `.decisions` folders from the git repository, newest first. Before the first capture it says that a capture appears after you commit a change to an old line. Each entry shows the before image and the after image stacked. Edit the Why box and leave the field to save `note.md`.

A new capture shows a notification with Fill in why. That opens a form in the editor for the reason, with the two images above the text box. `note.md` itself is a heading, that reason, and the images. If the command-line hook is also installed, the shared change hash keeps the editor from writing a second copy of the same capture.

![Fill in why](extension/media/why-panel-dark.png)

To publish on Open VSX, download the CI vsix and run `npx ovsx publish decap-0.1.3.vsix` with your own token. The Marketplace is a separate publisher account and `vsce publish`. This repository has no publish workflow and no publish token.

The plan is in [PLAN.md](PLAN.md).
