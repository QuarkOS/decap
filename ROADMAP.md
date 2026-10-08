# Roadmap

What to do next so the why behind a change is kept. Ranked by how much a person loses when the item is missing. The rank reason is one line under each item.

PLAN.md remains the original plan.

## Releases

- 0.1.0 shipped the command line tool and a hook that runs after a commit.
- 0.1.1 captures inside the editor. It watches the editor git view and draws the images in the extension.
- 0.1.2 added a status message when a commit is skipped, the decap log, a sidebar that can see a nested repository, and a status item that stays until the why is filled in.
- 0.1.3 opens Fill in why as a form. The note is a heading, the why, and the two images. The commit, the file, the lines, the age, and the change hash sit in an HTML comment.
- 0.1.4 is already in flight.
  - Review anyway, for a commit younger than the age rule.
  - decap: Review last commit

The age rule is `decap.minAge`. The default is 12 hours. The age comes from git blame on the parent.

## Ranked

### 1. Record commits made while the editor is closed

Ranked first because that why is never asked for.

The code shows the editor stores the branch tip when a repository opens. The code shows it reacts only when a later tip replaces that one. Inferred from that, a commit made with the window closed is never recorded. The code shows a tip older than three minutes is ignored (180 seconds). Inferred from that, opening the editor later still skips the missed commit.

### 2. Keep an old why across a rebase

Ranked second because a rebase can ask for the same why again or leave the note on a commit that is gone.

The code shows a moved branch tip goes through the same capture path as a normal commit. The code shows the change hash includes the file, the line numbers, and the changed lines. Inferred from that hash, a rebase that moves the lines writes a second note with an empty why. Inferred from that hash, a rebase that keeps the lines skips the new commit. The code shows the commit id is stored when the note is created. Inferred from the skip, that id stays pointed at the old commit.

A scratch rebase on git 2.43 wrote a new committer time and ran the post-commit hook. That was observed in a temporary repository. The code shows a committer time under three minutes counts as a new commit. Inferred from those two facts, an open editor tries to record each replayed commit. Whether older git runs that hook on rebase is a guess.

### 3. Keep the Python command line tool

Ranked third because it is the path that still writes a note when the editor is shut.

Proposal for Emilio, who can override it. Keep the Python tool. The changelog shows 0.1.0 offered to install the hook from the editor. The code shows the current commands are Snap, Open decisions, Show log, and Fill in why. The code shows the hook runs the Python tool after a commit. Inferred from that, the tool still records a commit when the editor is shut. Keep the tool until the editor covers a closed window and a rebase.

### 4. Keep the editor and the command line in step

Ranked fourth because a drift turns one change into two notes, or stops an old why from counting.

Standing rule. The code shows both tools build the change hash from the same inputs. A test locks the same two sample hashes. The code shows both still read that hash from notes written by 0.1.0 through 0.1.2 and from current notes. Keep the rules, the change hash, and old notes readable on every later change.

### 5. List and search past decisions

Ranked fifth because the why has to be findable later.

The code shows each row is the folder name plus the file path. The code shows the why text only in the box for the selected row. The code shows no search field. Inferred from the folder layout, the editor's own search can already find words inside the notes. Show the first line of the why on each row. Let the list filter by that why, the file name, or the age.

### 6. Show the waiting count when the form opens

Ranked sixth because a second why can sit unseen until the first save.

The code shows the form banner `Saved. 1 more to fill in.` only after a save, using whatever count remains. The code shows the status item already adds a count when more than one capture is waiting. The form should show that count on first open too.

### 7. Clear the extra pop-up when the form moves on

Ranked seventh because a leftover prompt can reopen a capture the form already left.

The code shows each new capture opens its own message. The code shows nothing closes that message when Save moves the form. The code shows the Fill in why action opens that message's own capture. Inferred from that, the leftover message reopens the earlier capture after the form has moved on.

### 8. Make the form heading easy to see

Ranked eighth because the heading names the file you are explaining.

The code shows the heading is the same 13px size as the body text.

### 9. Leave Saved on screen long enough to read

Ranked ninth because the why is already stored and this is only the confirmation.

The code shows the form is replaced with the word Saved when nothing else is waiting. The code shows that page closes after 700 milliseconds (about 0.7 seconds).

### 10. Use the theme blue for the text box focus

Ranked last because you can still type the why.

The code shows the form text box sets no focus color. The code shows the sidebar box is the same. Inferred from that, the orange ring is the webview default rather than the editor focus color.
