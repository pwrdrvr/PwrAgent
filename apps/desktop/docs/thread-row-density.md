# Thread Row Density and X-ray

Moved verbatim from [apps/desktop/AGENTS.md](../AGENTS.md), which keeps
a summary and says when to read this document.

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
