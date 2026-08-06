# Operator Preferences for Orchestration Agents (`~/.pwragent/AGENTS.md`)

PwrAgent's orchestration and intake agents — the Star Map `[+]` intake
sub-agent, in-thread agents using the `federation` and `thread_orchestration`
tool catalogs — consult an operator-authored preferences file before choosing
where and how to start threads:

```
~/.pwragent/AGENTS.md
```

The path honors `PWRAGENT_HOME`, so an overridden PwrAgent root moves the
file with it (`$PWRAGENT_HOME/AGENTS.md`). The file is per-machine and is not
synced across federated instances: each instance's agents read the local
file, which is also where per-instance routing hints belong.

## What it is

A plain Markdown file the operator writes for agents, in the same spirit as a
repository `AGENTS.md` — but scoped to the operator's PwrAgent workflow
rather than any one repo. Agents read it as guidance, not configuration:
there is no schema, no parser, and no enforcement. If the file is missing,
agents proceed with instance and launchpad defaults.

## What belongs in it

- **Default projects and routing**: "PwrSnap work goes to the Studio Mac";
  "anything long-running belongs on the rack mini"; "default to the
  PwrAgent repo when I say 'the app'."
- **Thread-startup preferences**: preferred models or execution modes for
  particular kinds of work, when to use a worktree versus the local
  checkout, base branches to start from.
- **Naming conventions**: how the operator likes threads titled or grouped.
- **Anything else an intake agent should know** before creating work on the
  operator's behalf.

## What does NOT belong in it

- **Secrets** — tokens, API keys, passwords. The file is read into agent
  context; treat it as visible to every model the operator runs.
- **Per-repository instructions** — those live in the repository's own
  `AGENTS.md`, which the coding agent reads once it is working in that repo.
- **Machine-readable configuration** — settings with real switches belong in
  `config.toml`, not prose.

## How agents discover it

The `federation` agent-tool catalog's `create_instance_thread` description
tells agents to consult `~/.pwragent/AGENTS.md` (when it exists) before
choosing thread settings. Agents with filesystem access read the file
directly; there is deliberately no dedicated tool for it — the convention is
a file, not an API, so operators can edit it with anything and agents can
read it like any other context.

## Example

```markdown
# My PwrAgent preferences

- PwrSnap work runs on "Studio Mac" (it has the capture hardware).
- Long-running agents (soak tests, batch refactors) go to "rack mini".
- Default new threads to worktrees; only use the local checkout when I
  explicitly say so.
- Title threads as `<area>: <task>` — e.g. "recorder: fix crash on stop".
- When I say "the app" with no repo context, I mean ~/github/PwrAgent.
```
