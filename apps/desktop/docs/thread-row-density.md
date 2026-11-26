# Thread Row Density and X-ray

Moved from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps a summary and
says when to read this document. Relative links were updated for this location.

## Thread Row Density and X-ray

Density is `<html data-density>`: absent for Mission Control, `compact`, or
`minimal`. It lives in CSS only, so a density change re-renders no row.

- **Mission Control and Compact** draw at most two PR chips in the flow: the
  lead PR's own chip and a `+N PRs` chip (`PrRollupChip` with
  `variant="overflow"`, rule in `resolvePrOverflow`) whose list holds every
  PR and Detach all.
- **Compact** hides every `.thread-row__chip` without the
  `thread-row__chip--persistent` marker. PR chips and reactions stay.
- **Minimal** hides every flow chip without the `thread-row__chip--essential`
  marker (held messages, approvals, questions). The title line instead shows,
  each mounted only while `ThreadRowDensityContext` says `minimal`: a pencil
  before the title for an unsent draft, the reactions, and `PrRollupChip`, one
  chip that wears the least ready PR's state (`pr-rollup.ts`) with a hover list
  of every PR. Add `--essential` only to a chip that is waiting on the
  operator.
- **X-ray** (`lib/xray-mode.ts`): holding ⌘ (Ctrl off macOS) sets
  `<html data-xray>` and lifts one row into a card with every chip
  (`features/navigation/xray-spy-card.ts`): the row under the pointer, or
  else the selected row if it is on screen. The lifted shell gets
  `data-xray-target`, which every density rule excludes, and keeps its own
  height, so no other row moves and the list never scrolls. Lifting every
  row pushed the selected thread out of sight. A double press, or the
  badge's pin, keeps X-ray on.
- **Previews.** The Settings and onboarding density pickers render real
  `ThreadRow`s, inert, inside `.density-preview--<density>`. Write each density
  rule twice: the `:root[data-density="…"] … :not(:is(.density-preview, [data-xray-target]) *)`
  half and the `.density-preview--… ` half.
  `styles/__tests__/density-contract.test.ts` fails when a rule lacks either.

## Working rows hold their progress chips

An agent edits, commits, pushes and adds to-do cards many times a turn. Each
change resized its row and moved every row below it, including the row under
the pointer. So while a thread's turn or owned worker runs
(`isThreadTurnRunning`) and it is not the open thread, its row passes
`holdWorkProgress` to
`ThreadMetaChips`, which shows these as they were when the hold began:

- the branch chip (`gitBranch`, `observedGitBranch`);
- the uncommitted and unpushed chips (`gitWorkingState`);
- the to-do count's cards.

Opening the thread, or the turn ending, shows the live values at once.
Background tasks left running after the turn keep the row's working mark but
not the hold, so a turn's results show when it ends, not when a dev server or
watcher it started exits. Every
other chip stays live: approvals, input, questions and held messages wait on
the operator, PR chips mark a milestone, and drafts are the operator's own.
A row that mounts mid-turn shows its first values. X-ray and chip tooltips
show what the row shows.

Rows show no branch-drift chip (`! now <branch>`). Agents switch branches
mid-turn, so it came and went on rows nobody had open; the open thread's
`ThreadWarnings` names the drift.

`__tests__/thread-row-work-progress.property.test.ts` checks these rules over
the pure hold model (`thread-row-work-progress.ts`), and
`__tests__/thread-row-work-progress.model.test.tsx` ties that model to a
mounted `ThreadRow` against an idle oracle row alongside the shrunk
counterexamples.
