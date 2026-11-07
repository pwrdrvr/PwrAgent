# Property, model and oracle tests

Most PwrAgent tests are **example tests**: pick one input, write down the
output you expect. They check only the cases someone thought of, and they
check what the author *believed*. Twice in this repo's history, the expected
output was itself the bug, and the test kept it in place:

- **#2400 → #3119 (32 days).** A test asserted that a thread starting in a
  project shows *below* the project's existing pin:
  `["Pinned thread, pinned", "Add a crop tool, starting in PwrSnap"]`. This
  file already said the opposite: "A new pin, including an auto-pinned new
  thread, lands at the top of the ordinary pins." #3119 fixed the order and
  flipped the assertion.
- **#2762 → #3117 (11 days).** Claude reports the Fable weekly allowance as
  `model_scoped:Fable` in usage snapshots and as `seven_day_overage_included`
  in streamed updates. A test asserted that the streamed reading is named
  "Weekly limit with extra usage", so the Pricing rail showed one allowance
  as two limits. #3117 merged them and flipped the assertion.

The three ideas here let the computer choose the inputs. We use
[fast-check](https://fast-check.dev/) inside Vitest. It is already a root
`devDependency`; see [Dependency and licensing](#dependency-and-licensing).

## The three words

**Property.** A rule that must hold for *every* input, written as code.
fast-check generates hundreds of inputs. When one breaks the rule, it
*shrinks* that input to the smallest one that still fails, and prints it with
a seed so you can replay it.

> *"Adding synthetic rows to a transcript keeps the original rows in their
> order."* Against the pre-#2826 `injectPermissionTransitions`, this failed on
> the first generated input (2 ms). It shrank to one row stamped `1`, one row
> with no timestamp, and a permission change at `0`: the untimed row jumped to
> the top. All 8 of the module's tests gave every row a timestamp.

**Model.** For code with state or concurrency, a small stand-in that is
obviously correct. The test generates random sequences of commands
(`fc.commands`) or random orderings of async work (`fc.scheduler`). It runs
each one on the real code and on the model, and checks that they agree after
every step.

> Model: a list of entries, each with the *set* of reasons it is held.
> Commands: `submit`, `submitHeld(reason)`, `releaseHold(reason)`. Rule: an
> entry held for a reason never starts until that reason is released. Against
> the real pre-#3347 `ThreadTurnQueue`, it failed within 6 runs (62 ms) and
> shrank to `submitHeld("locked") → submitHeld("awaiting-review") →
> release("awaiting-review") → submitHeld("locked")`. The 60 example tests
> before the fix held the queue for one reason at a time.

**Oracle.** Whatever tells the test what the right answer is. It can be one
of these:

- **A slow, obviously correct version** of the function, or a trusted library.
- **The system that owns the data.** Real git in a temp repo for worktrees,
  branches and PR heads. The provider's own event order (turn, then item
  sequence) for transcripts. The owning instance for federated rows.
- **A second code path** that must give the same answer, called a
  *differential* test: a usage snapshot and a streamed update describing the
  same limit, or the renderer's queue projection and the owner's FIFO.
  `owner-conformance.test.ts` already compares the desktop owner with the
  Outpost this way, against a baseline of known differences.

> *"Choosing a release from GitHub's list matches the npm `semver` package,
> whatever order the list arrives in."* Against the pre-#492 updater, it
> failed in 1 run, shrunk to two stable releases, `v0.0.0` and `v0.0.1`.

The three work together. A property needs an oracle to say what "correct"
means, and a model test usually uses the model as its oracle.

## What the history showed

Each test below ran against the code from just before the fix, extracted with
`git show <fix>^`. Each failed there and passed on the fix (300–20,000 runs).
Run counts vary with the random seed.

| Fix | Bug | Test | Found in |
| --- | --- | --- | --- |
| #3347 | A second hold erased the first hold's reason, so unlocking ran failed-turn retries without review. Live about 1 month. | Model of `ThreadTurnQueue` | 6 runs; shrunk to 4 steps |
| #3339 | "Unlocking sends what it held, in order." It sent them newest first. Live about 2 months. | Property: same-kind entries start in arrival order | 1–2 runs; shrunk to `["held", "held"]` |
| #3292 | A late acknowledgement moved a finished automation run back to running. Live about 5½ months. | Property: status never moves backwards | 1–3 runs; shrunk to `completed, queued` |
| #2826 | A transcript drew one order, then reordered itself a second later. Live about 5½ months. | Property: injection keeps row order | Run 1 |
| #492 | The Beta channel offered beta.1 next to beta.8. | Oracle: npm `semver`; order independence | 1–7 runs |
| #2773 | Worktree identity lost precision for inode numbers above 2^53. Live 1 week. | Property: identity round-trips | Run 1 |

Notes on the runs:

- #3347 and #3339 ran the real, unmodified `ThreadTurnQueue`.
- #2826 and #492 ran the real pre-fix functions. #492's selection was 7
  inline lines, wrapped unchanged in a function.
- #3292 copied `AutomationStore`'s lifecycle methods exactly and replaced
  SQLite with a `Map`.
- #2773 simulated Node's float64 `lstat()`, so it is the weakest of the six.

Other repeats, not run. A test for each is a sketch until someone runs it
against the pre-fix code:

- **Transcript order.** On 2026-05-02, #142 wrote the rule down: "The
  transcript render order must be globally nondecreasing by the canonical
  event order for all visible entries." The rule never became a test. Nine
  more ordering fixes followed, from #224 to #2826, and 12 of the 14 core
  ordering fixes patch `useThreadSessionState.ts`.
- **Duplicate terminal replies** were fixed three times: #1852, #1891 and
  #3056.
- **One PR refresh hook looped twice:** #251, then #346 three days later.
- **Three stale reads in navigation.** #2144 and #2953 restored a removed
  pin, and #3012 moved a finished turn a second time. In each, a read that
  started before a write landed after it.

## When to write one

- **Fixing a bug.** Write the rule the bug broke as a property or model
  invariant, and confirm it fails on the pre-fix code before you fix it. Also
  keep the shrunk counterexample as a plain example test, so the regression
  has a name.
- **A rule already written in prose.** This file, a design doc, a PR
  description and UI copy all make promises: "Unlocking sends what it held, in
  order", "A thread can move at most twice during one turn", "Pins have two
  tiers". Encode the promise as a property. Don't leave it to examples.
- **Pure logic with rules:** pin ranks and tiers, Attention order, search
  ranking, release selection, rate-limit naming, path and identity handling,
  transcript merge, parsers. Write a property.
- **State and concurrency:** `ThreadTurnQueue`, automation run lifecycle,
  scheduled actions, update download and replacement, renderer query stores
  whose reads can land out of order. Write a model (`fc.commands`,
  `fc.scheduler`).
- **Anything that re-derives state another system owns.** Use the owner as
  the oracle:
  - git, through real git commands in a temp dir, for worktrees, branches,
    squash merges and PR heads;
  - a provider's event stream: generate valid sequences of `turn/started`,
    item events and `turn/completed`, with redeliveries, ties and late reads;
  - the thread's owning instance, for federated rows.
- **Two places answer the same question,** such as a usage snapshot and a
  stream, the renderer and main, or the desktop owner and the Outpost. Write
  a differential test that they agree.
- **Before an `expect` pins a label, an order, a count or an empty result,**
  say the rule in words. If the rule and the output disagree, the output is
  the bug. #3119 and #3117 are what happens when the assertion wins.

## How to write them

- **Name the file `<module>.property.test.ts`** in the `__tests__` directory
  that `vitest.workspace.ts` already includes for that code:
  - `apps/desktop/src/main/__tests__/` (project `desktop-main`);
  - `apps/desktop/src/renderer/src/**/__tests__/`, as `.test.ts` for pure
    logic (`desktop-renderer-node`, no DOM). Use `.test.tsx` only when the
    property needs jsdom;
  - `packages/shared/src/**/__tests__/` and `packages/owner-core/src/**/__tests__/`;
  - `packages/messaging/**/src/**/*.test.ts`.
- **Build inputs the way the system produces them.** Generate a list of
  operations and replay it, not random structs: provider events, queue
  commands, pin moves, reads that land late. Don't generate states the
  system can't produce, such as a completed turn that never started.
  Impossible states give false failures. A stale or duplicate event is
  possible, so generate it on purpose.
- **Take the property from a promise:** this file, the code's comment, the
  design, or what the operator was told. Never take it from today's output.
- **Narrow, don't weaken.** A counterexample may be a case the code handles
  on purpose. If so, restrict the generator or add `fc.pre(...)`, with a
  comment saying why. Don't loosen the assertion until it passes.
- **Budget the runs.** The default test timeout is 5 s on Linux and macOS and 30 s on
  Windows. CI runs unit tests on all three, and Windows desktop-main run time
  can vary by more than 2× between runs.
  - Pure properties: keep the default `numRuns` (100), and a file under
    about 200 ms on Linux.
  - Models over a real `StateDb`, real git or a mounted hook: keep
    `numRuns` around 25–50, and each test under about 1 s on Linux. Open
    databases from the migrated template, as other main-process tests do.
- **Use the scheduler and injected clocks for ordering and time,** not real
  sleeps or fake timers. `ThreadTurnQueue` already takes `now` and its other
  effects as options.
- **Don't pin a seed in committed tests.** On failure, fast-check prints
  `seed` and `path`. Replay with `fc.assert(prop, { seed, path })`.
- **A property failure on an unrelated PR is a real bug.** Reproduce it from
  the printed seed and fix it or file it. Never re-run CI to get green.
- **Generated data stays generated.** Don't seed a property from Codex
  storage files; the Codex data boundary in [AGENTS.md](../AGENTS.md) applies.
  Recorded fixtures the test owns are fine.

## The updater is shared with PwrGit

PwrAgent's update feature was ported from PwrGit (see
[the update feature guide](../apps/desktop/src/renderer/src/features/update/AGENTS.md)).
`selectChannelReleases` and `compareSemver` in
`apps/desktop/src/main/auto-updater.ts` choose a release for each channel,
and `auto-updater-supersede.test.ts` covers a downloaded update that a newer
release replaces.

[PwrGit#554](https://github.com/pwrdrvr/PwrGit/pull/554) added properties for
`selectChannelReleases` and an `fc.commands` model of its held update. The
port is in `apps/desktop/src/main/__tests__/auto-updater.property.test.ts`,
with PwrAgent's event-driven completion and cancellation flow. PwrGit's
request-budget invariant (I5) is in
`apps/desktop/src/main/__tests__/auto-updater.request-budget.property.test.ts`,
against the real on-disk release cache. Keep the two sets in step. The rules
are the same in every Pwr app:

- No channel offers less than Stable's latest release.
- The result doesn't depend on GitHub's list order.
- A Restart offer always names an update that is still on disk.
- Automatic release-list requests keep their budget across restarts, and no
  request goes out before a rate limit resets.

## Dependency and licensing

- The root [package.json](../package.json) already pins `fast-check` 4.10.2
  (MIT) as a `devDependency`. [pnpm-lock.yaml](../pnpm-lock.yaml) resolves
  that version with its only dependency, pure-rand 8.4.2 (MIT).
- Check any newer version against the seven-day `minimumReleaseAge` in
  `pnpm-workspace.yaml` before you pick it.
- These test-only dependencies do not ship, so the third-party notice does
  not list them. Run `pnpm licenses:check` when updating them.
