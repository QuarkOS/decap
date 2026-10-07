# Changelog

## 0.1.2

The sidebar reads `.decisions` from the git repository, including a repository one folder below the folder you opened. Fill in why opens that note, and a status item stays until the Why line has text. A commit that changes only new lines, or only lines younger than 12 hours, says so in the status bar. The first too-new commit explains the 12 hour rule and `git config decap.minAge 0`. `decap: Show log` opens the output channel that records each commit.

## 0.1.1

The editor captures by itself. Installing the extension is the whole setup. It watches new commits while the window is open, writes the same `.decisions` folders as the command-line tool, and does not need Python or a git hook. A new capture offers Fill in why. Commits made while the editor is closed are not captured. The command-line tool and its hook remain available for terminal-only use.

## 0.1.0

First release. The extension offers to install the decap command and the post-commit hook, captures the working tree with Alt+Shift+S, and lists each capture in the sidebar with the before and after images side by side.
