# docs/plans/ — Agent Guidance

This directory holds **implementation plan files** — point-in-time
decision artifacts produced by `/ce:plan` (and earlier planning
workflows). Each one documents what was decided at the time, in
service of executing a specific implementation.

The rules below apply equally to `docs/brainstorms/` (pre-plan
requirements docs from `/ce:brainstorm`) and to `docs/solutions/`
(post-implementation learnings from `/ce:compound`) once that
directory exists. The repo's [`.rgignore`](../../.rgignore) lists
all three.

## Don't edit historical plan files

**You MUST NOT rewrite plan files that were not created on your
current branch.** They are a historical record of what was decided
and when. Editing them after the fact:

- Destroys the chronology that makes the record useful.
- Wastes tokens on a file nobody will read again unless they're
  doing archaeology.
- Reads as scope creep on any PR that touches them.
- Confuses the next agent looking at git blame for "why did we
  choose X over Y?" — the trail leads to a rewrite, not the
  original decision.

The **one exception** is the plan file your current branch is
itself executing — that one is fair game to update with checkbox
progress, dependency notes, deferred-to-implementation answers
resolved during the work, etc. as you go.

If you find a plan file that's factually wrong about something
that matters today (rare), open an issue or a Slack-channel-style
note in the PR you're working on — don't silently rewrite the plan.

## Read plans, but selectively

You CAN read these files. Read them when:

- You're investigating "why was this built this way" and the git
  blame trail points to a specific plan.
- The plan you're executing references a prior plan by name.
- A non-obvious architectural choice has you stuck and you suspect
  the decision rationale is captured in a plan.

Don't read them when:

- You're doing a routine implementation that doesn't need
  historical context.
- You're searching for code patterns or current API shape (the
  live codebase, [ARCHITECTURE.md](../../ARCHITECTURE.md), and
  package-level `AGENTS.md` files are faster, more accurate
  sources of truth).
- You'd be reading "just in case" — the cost is real (token
  budget, distraction from the actual task).

## Skip from ripgrep by default

The repo ships a [`.rgignore`](../../.rgignore) at the root that
excludes `docs/plans/`, `docs/brainstorms/`, and `docs/solutions/`
from default `rg` searches. Ripgrep picks it up automatically — no
flag required.

To search across plans intentionally (the rare case):

```bash
rg --no-ignore '<term>' docs/plans/
# or the short form
rg -u '<term>' docs/plans/
```

For everything else, the default `rg` invocation now returns the
signal you want: matches in the live codebase, not in years of
plan files describing decisions that already shipped.
