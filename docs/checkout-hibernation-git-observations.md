# Checkout hibernation Git observations

This performance change starts at main `2b8f0ce2d2afdfd3f836dd35f5b8258537955d74`, which includes
ownership PR [#3904](https://github.com/pwrdrvr/PwrAgent/pull/3904).
That PR owns test retirement/admission; updater #3896 is separate. Searches of
open PRs and known threads found no other production Git-launch optimization
owner. The earlier ownership report and its five-second deadline evidence stay
unchanged in [checkout-hibernation-fixture-ownership.md](checkout-hibernation-fixture-ownership.md).
The initiating deadline remains unattributed.

## Observation boundary

`inspectMaintenanceWorkspace` previously launched three adjacent `rev-parse`
queries: work-tree discovery, absolute admin directory, and absolute common
directory. One invocation can answer all three:

```text
rev-parse --path-format=absolute --is-inside-work-tree --absolute-git-dir --git-common-dir
```

The answers remain local to one invocation of the inspection. A later review,
admission, snapshot preparation, snapshot tree verification, or removal observes
Git again. There is no shared observation, cache, timer, or persistence change.
Primary-checkout comparison and subsequent HEAD/retention, changed-file and size
checks retain their existing decisions.

Git separates these answers with newlines. If the record has more than three
fields, a legal pathname may contain a newline: use the original two separate
directory queries. The real-Git newline regression covers both primary and linked
checkouts. Bare and separate-Git-dir layouts, nested cwd and detached HEAD also
have independent Git layout oracles.

The following candidates were deliberately left unchanged:

| Queries | Reason to keep their boundary |
| --- | --- |
| Later admin-directory read in hibernation inspection | It precedes operation-marker and lock checks after other awaited Git work; checkout identity can change. |
| HEAD, symbolic ref, status and stash | These are fresh eligibility inputs. Deriving them from another command would need additional proofs of output and failure semantics. |
| Changed, untracked and ignored file lists | These are different sets used by snapshot size, submodule, symlink and rebuildable-output rules. |
| Snapshot/index/tree/ref reads and writes | They prove saved content, reference durability and rollback before deletion. |
| Registration, HEAD and lock checks at removal | They guard later mutations and must remain fresh. |

## Cold launch measurement

Each measurement is a new native Vitest invocation of the unchanged test
`reads archived fleet membership once for a multi-wave reviewed hibernation batch`.
It still creates six target worktrees and 220 unrelated owners, crosses multiple
apply waves and asserts one archived-membership read. Its source SHA-256 is
`1a3c2fd02e1d1cab29824daa050a08057f4e1953b940fc3531710f285baab2f5`. No fixture cardinality, property bound, deadline, worker,
concurrency, isolation, or SQLite budget changed.

Environment: macOS-27.2-arm64-arm-64bit-Mach-O, Node v24.22.1, git version 2.55.0.
This checkout installed its own dependencies with `pnpm install --frozen-lockfile`;
the lockfile SHA-256 is `121c3e5785692a1c27bd7ac544e755624d3dcac126ec6175bb59a2adf367a859`.

| Trace2 process starts, including Git children | Before | After |
| --- | ---: | ---: |
| All commands | 281 | 257 |
| `rev-parse` | 102 | 78 |
| Standalone `--is-inside-work-tree` | 12 | 0 |
| Standalone `--absolute-git-dir` | 30 | 18 |
| Standalone absolute `--git-common-dir` | 18 | 6 |
| Combined layout query | 0 | 12 |
| All other command categories combined | 179 | 179 |

Twelve inspection boundaries each save two launches: **24 fewer starts (8.5%)**.
`diff` (18), `ls-files` (30), `status` (12), `symbolic-ref` (18), `stash` (12),
and every other non-`rev-parse` category are unchanged. This proves reduced
launch work, not a latency improvement or host contention. The after measurement
overlapped a separate oracle run; no before/after wall-time conclusion is drawn.
The historical stage timings and worker CPU observation are not reinterpreted.

Commands, run from this checkout with the normal native bootstrap:

```sh
GIT_TRACE2_EVENT="$PWD/.local/hibernation-git-before.jsonl" pnpm test apps/desktop/src/main/__tests__/checkout-hibernation.test.ts -t 'reads archived fleet membership once for a multi-wave reviewed hibernation batch' > .local/hibernation-before.log 2>&1
GIT_TRACE2_EVENT="$PWD/.local/hibernation-git-after.jsonl" pnpm test apps/desktop/src/main/__tests__/checkout-hibernation.test.ts -t 'reads archived fleet membership once for a multi-wave reviewed hibernation batch' > .local/hibernation-after.log 2>&1
```

The sandboxed before command failed in the documented runtime-staging signature
check before tests. The exact command then passed outside the sandbox; signing
and the build hook were unchanged. Raw traces, command counts and metadata are
retained in this worktree's ignored `.local/hibernation-git-*` artifacts.

| Artifact | SHA-256 |
| --- | --- |
| Before production source | `f6ba5707f133888c0c69ac10fa6728bc0f6ee2a7d7184776d2a1b4c04b20d6f9` |
| After production source | `da9e5a28fd623b63973ac6f828729b098c65d42b7450fd4f38d73c33eab72db6` |
| Before trace | `4aae181b09e00acfedc7d6879fe5f6f18a04fb7fbf8fb160f98a9b33ae63d503` |
| After trace | `ba1197986f709eb612eb496dd95fdc69729cfd854bfea24807a0aea44cb9f5cf` |
| Before native log | `dcd5dbaf589d4b4d71240b150bc51596f2a7619e2f486bb263fa16cb6ef64890` |
| After native log | `7900712d56cf1d80b292b1e571fe6e57c8d7bbd25c3d4172be97dcaaaf02ea9e` |

## Independent safety checks

The new real-Git property compares primary/linked classification with Git's
separate directory answers while changing branch attachment and cwd. Its
one-layout-launch budget fails on unchanged production code: three launches,
shrinking to `[false, false, false]`. The other seven initial oracle cases pass
before the optimization; all ten final layout/mutation cases pass after it.

Review-to-admission cases mutate tracked/untracked files, stash state, a real
bisect, unretained detached HEAD, a branch whose stash parent differs from the
current HEAD, and replacement of the linked checkout by a primary repository.
Each next inspection observes the mutation rather than retaining review facts.

Existing, unchanged hibernation tests prove late snapshot edits retain the
checkout and roll back the snapshot ref, and successful hibernation/restore
recovers branch, HEAD, tracked and untracked contents. Existing archive Git
oracles exercise late HEAD, lock, terminal-lock, gitfile, backlink, common-dir and
registration mutations, plus independent snapshot refs and preserved content.
The native validation command passed 133 tests in five files; subsequently added
bare/separate-layout cases passed with the complete ten-test layout oracle.
No SQLite writes were added: incremental write volume is 0 MB/day.
