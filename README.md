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

decap writes `.decisions/<date>_<time>_<slug>/` with `before.png`, `after.png`, and `note.md`. Fill in the `Why:` line.

A notification names the folder when `notify-send` is installed. A missing `notify-send` is skipped.

The plan is in [PLAN.md](PLAN.md).
