# decap

Captures before/after images of code decisions automatically.

When a commit changes code that had survived at least ~12 hours, decap renders the old and new hunk as syntax-highlighted PNGs and drops them, with a note to fill in, into `.decisions/`. A manual `decap snap` (bound to a keyboard shortcut) does the same for uncommitted changes.

Built for interviews and the Diplomprojekt Defensio: proof of what changed and why.

Status: planning. See [PLAN.md](PLAN.md).
