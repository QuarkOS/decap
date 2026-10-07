# Changelog

## 0.1.1

Setup no longer asks pip or pipx to install decap, and it never uses the private git URL or the PyPI name. The extension keeps its own Python environment and a bundled copy of the CLI. A status bar item and the sidebar stay visible until that environment and the post-commit hook are ready. A new capture offers Fill in why, which opens that note with the Why box focused.

## 0.1.0

First release. The extension offers to install the decap command and the post-commit hook, captures the working tree with Alt+Shift+S, and lists each capture in the sidebar with the before and after images side by side.
