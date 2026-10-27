# Contributor workflow with gh-stack

Use `gh stack` from the intended branch with a clean worktree. Check the installed
version with `gh extension list`, and inspect the stack before rebasing:

```sh
git status --short
git branch --show-current
git worktree list
gh stack view
gh stack rebase --upstack --remote origin
```

`--upstack` includes the current layer and layers above it. A merged parent below
that range still affects the boundary used to select commits. Inspect the result
before pushing or submitting; a successful command alone does not establish that
only the intended commits survived.

As verified on 2026-10-27, the latest official release is
[v0.3.0](https://github.com/github/gh-stack/releases/tag/v0.3.0), commit
`2a49e6751238633db504655d8a8eba3e433e827d`. It includes
[upstream #586](https://github.com/github/gh-stack/pull/586), which fixes stale
merged-parent boundaries. The procedure below remains useful for the affected
v0.1.1 installation. Finish or abort active operations before an approved upgrade.
New versions share the catalog and recovery journals across linked worktrees;
[upstream's tracking guidance](https://github.com/github/gh-stack/tree/v0.3.0#local-tracking)
explicitly says not to mix old and new versions in one clone. An upgrade is a
coordinated operator action, not a recovery command to run automatically.

## Recognize the stale merged-parent boundary

In the reported 2026-10-27 incident, these immutable commits identify the case:

| Role | Commit |
| --- | --- |
| Parent PR #2931 head | `d9e8d5cab1484c4404e175353c27a5206725f933` |
| Parent's squash on main | `6ee2802ed420d4e9d576523b48e6067bf8764b32` |
| Main base already integrated into child #2935 | `bbaa4472031c8820a13eb9b96b62064f94061230` |
| Child head before the failed rebase | `852dc9e47c210e02eebac5e87fe6e09892fb1062` |
| Fetched main destination, abbreviated in the incident | `898cdecd9` |

With v0.1.1, `gh stack rebase --upstack --remote origin` tried to replay
`6ee2802ed` onto the newer main. The child already contained that squash, but
its recorded base could still be an ancestor from before the squash. In
[`resolveRebaseOldBase` at v0.1.1](https://github.com/github/gh-stack/blob/v0.1.1/cmd/utils.go#L1081-L1114),
the resolver accepts that recorded ancestor before checking the newer fork point.
Being an ancestor proves reachability, not that it is the latest safe cutoff.
A replay conflict in an already-landed change can therefore be a boundary error.

Check the history rather than resolving or skipping the landed commit:

```sh
# While stopped at the unexpected conflict:
git show -s --format='%H %s' REBASE_HEAD
gh stack rebase --abort
git status --short
git branch --show-current
```

Use gh-stack's abort so its recovery journal and branch snapshots are handled
together. If abort fails, preserve the journal and stop; do not remove it manually
or proceed to unstack. After a successful abort, confirm the original child head
and a clean worktree. For this incident, the following ancestry checks should all
exit 0 before applying the recovery:

```sh
git rev-parse HEAD
git merge-base --is-ancestor 6ee2802ed420d4e9d576523b48e6067bf8764b32 HEAD
git merge-base --is-ancestor bbaa4472031c8820a13eb9b96b62064f94061230 HEAD
git merge-base --is-ancestor bbaa4472031c8820a13eb9b96b62064f94061230 main
```

If these checks fail, investigate that history separately. This recovery is for
an already-integrated child, not a general recipe for dropping parent commits.

## Recover local tracking without changing the GitHub stack

Keep the affected stack's worktrees quiescent. Check that no other gh-stack
operation is active in the clone. Save a backup ref for the child, record the
active layer order, and copy any existing catalogs to a separate backup directory:

```sh
git branch backup/mcp-gateway-before-stack-recovery HEAD
git rev-parse --absolute-git-dir
git rev-parse --path-format=absolute --git-common-dir
```

v0.1.1 uses `gh-stack` in the Git directory; v0.3.0 uses it in the common Git
directory. Inspect both paths and retain both files if present. Do not delete
or replace a whole catalog: it can contain unrelated stacks. A backup of a shared
catalog must not later overwrite changes made by another worktree.

Record the remote stack identity and PR state before recovery. For the incident's
child, this is a read-only check:

```sh
gh pr view 2935 --repo pwrdrvr/PwrAgent --json number,url,headRefName,baseRefName,isDraft,autoMergeRequest,mergeStateStatus
```

When `feat/mcp-gateway-auto-review` is the only surviving active layer and the
checked-out branch is that child, run:

```sh
gh stack unstack --local
gh stack init --base main feat/mcp-gateway-auto-review
gh stack rebase --upstack --remote origin
```

Stop if any command fails. `unstack --local` removes the current stack's local
tracking only. `init` adopts the existing branch, recomputes its base from main,
and can rediscover its existing PR. Neither command deletes the branch or
un-stacks GitHub PRs. The final rebase updates local history; it does not push.
The new local stack may initially lack the remote stack's cached identity, even
though the remote stack still exists.

For multiple surviving active layers, inventory and pass **all** surviving
branches to `init` in bottom-to-top order instead of copying the single-child
command. Keep merged layers out of that rebuilt local chain. Do not use this
procedure across an active merge queue or an unresolved Git/gh-stack operation.

After recovery, verify:

```sh
git status --short
git merge-base --is-ancestor origin/main HEAD
git log --max-count=20 --oneline origin/main..HEAD
git diff --stat origin/main...HEAD
gh pr view 2935 --repo pwrdrvr/PwrAgent --json number,url,headRefName,baseRefName,isDraft,autoMergeRequest,mergeStateStatus
```

Review the full commit range if it exceeds 20 entries. The range should contain
only the child's intended changes, and trunk content should remain current.
Confirm that the GitHub stack, PR identities, draft state, and merge settings
match the recorded state. Review the intended PR bases and remote stack association
before a later push or submit, which are separate remote-changing operations.

`gh stack modify` is not a normalization shortcut: it checks stack linearity
before opening its editor. Nor should local repair use remote `gh stack unstack`.
In v0.1.1, a non-dissolved API response produces a generic queued/auto-merge
warning; that message is not evidence that the child has auto-merge enabled.
The incident's child was draft with `autoMergeRequest: null`. Source inspection
establishes the warning's generic nature, not the server's reason for retaining
that particular stack. Do not change merge settings to work around it.
Upstream [#574](https://github.com/github/gh-stack/pull/574) and
[#576](https://github.com/github/gh-stack/pull/576) separately changed partial
unstack handling in newer versions.

## Isolated reproduction and evidence

The checked-in
[fixture](../scripts/diagnostics/gh-stack-stale-boundary/fixture_test.go) creates
new repositories with invented commits. It uses a local bare origin and real Git
rebases; GitHub reads are mocked, credentials are isolated, and unexpected API
methods fail. It invokes the upstream Cobra commands directly, without the
installed extension or its update-check wrapper. It never opens a live worktree
or contacts GitHub for a PR mutation.

The fixture builds this history, with stale catalog base `A` for the child:

```text
          P1--P2                  parent (merged PR head)
         /
        A--S--B--T               main, origin/main at T
              \
               C                child already rebased onto B

S = squash of P1/P2; T changes the same file again; C = child-only change
```

An unrelated catalog entry and a separate linked worktree act as preservation
checks. On v0.1.1 the fixture expects selection of `A`, conflict at `S`, and
successful abort. It then verifies local unstack/init/rebase recovery. On v0.3.0,
it expects selection of `B`, a successful direct rebase, and successful local
reinitialization. Both cases require only `C` above the new trunk, current trunk
content, no remaining rebase journal, unchanged parent and remote refs, and an
unchanged unrelated stack/worktree. The mock permits only API reads, so a pass
also establishes that these commands cannot change remote PR settings in the
fixture. It does not test GitHub's live partial-unstack policy.

Verification on 2026-10-27 (macOS arm64, Go 1.26.0):

| Official source | `go vet ./...` exit | Focused fixture exit | Observed result |
| --- | --- | --- | --- |
| v0.1.1, `2bd699a544a09cb5c45a013d03416e0894b0454e` | 0 | 0 | Selected `A`, conflicted at `S`, aborted cleanly; local recovery passed. |
| v0.3.0, `2a49e6751238633db504655d8a8eba3e433e827d` | 0 | 0 | Selected `B`; direct rebase and local recovery passed. |
| v0.1.1 with the corrected-boundary expectation | — | 1 (expected) | Failed because selected `A` differs from expected `B`. |

Each positive run covers both direct behavior and recovery in independent
repositories. These are focused source-level checks, not the full upstream suite
or a test of the distributed release binaries. The Go fixture lives outside
PwrAgent's TypeScript test suite.

Run from the PwrAgent repository root with Go and Git installed. These commands
clone official source into a fresh temporary directory; they do not install or
upgrade any extension. Run each line successfully before proceeding:

```sh
pwragent_fixture_source="$PWD/scripts/diagnostics/gh-stack-stale-boundary/fixture_test.go"
pwragent_fixture_root=$(mktemp -d "${TMPDIR:-/tmp}/pwragent-gh-stack.XXXXXX")
git clone --branch v0.1.1 --depth 1 https://github.com/github/gh-stack.git "$pwragent_fixture_root/v011"
git clone --branch v0.3.0 --depth 1 https://github.com/github/gh-stack.git "$pwragent_fixture_root/v030"
cp "$pwragent_fixture_source" "$pwragent_fixture_root/v011/cmd/pwragent_boundary_fixture_test.go"
cp "$pwragent_fixture_source" "$pwragent_fixture_root/v030/cmd/pwragent_boundary_fixture_test.go"
```

In each temporary checkout, run `go mod download`, then `go vet ./...` before
the corresponding focused test:

```sh
cd "$pwragent_fixture_root/v011"
go mod download
go vet ./...
PWRAGENT_EXPECT_STALE_BOUNDARY=1 go test ./cmd -run '^TestPwrAgentStaleMergedBoundary$' -count=1 -v

cd "$pwragent_fixture_root/v030"
go mod download
go vet ./...
PWRAGENT_EXPECT_STALE_BOUNDARY=0 go test ./cmd -run '^TestPwrAgentStaleMergedBoundary$' -count=1 -v
```

The legacy test passes by reproducing the bug and verifying recovery. Running
v0.1.1 with `PWRAGENT_EXPECT_STALE_BOUNDARY=0` must fail at boundary selection;
that is the regression assertion for corrected behavior.

The appropriate upstream fix already exists in
[`f63271237b45fb121affa4ae69e4dd0b2785a37b`](https://github.com/github/gh-stack/commit/f63271237b45fb121affa4ae69e4dd0b2785a37b):
compare ancestry-validated recorded and fork-point candidates and prefer the
later cutoff, retain separate merged PR heads, and preserve recovery snapshots.
Do not substitute an unconditional ordinary merge-base fallback; after an amended
parent it can replay the old parent into the child. No new upstream patch or
issue is needed for this reproduced case. Any upstream publication or installed
extension change requires operator authorization.
