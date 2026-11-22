# Stacked pull requests across threads

Status: proposed. Nothing here is built.

- **Board:** [Stacked PRs UX Review](https://claude.ai/artifact/R3JdNvJfakiuVBCYSaDtR6#page-Stacked-PRs-UX-Review)
  on the PwrAgent design canvas. A byte-identical copy is
  [`pwragent-v2/project/Stacked PRs UX Review.dc.html`](pwragent-v2/project/Stacked%20PRs%20UX%20Review.dc.html).
  Turn 4 is a working prototype: agents operate one stack across four threads.
- **Builds on:** PwrGit's stacked-PR design,
  [pwrdrvr/PwrGit#646](https://github.com/pwrdrvr/PwrGit/pull/646): the
  catalog, the plan/apply engine, sync after a squash merge, submit and undo.
  This document doesn't repeat those decisions. It covers what PwrAgent adds.

PwrGit's problem is one person operating a stack. In PwrAgent, **agents** run
the stack: they create it, add layers, restack, reorder, submit, sync and merge.
Each layer usually lives in a different thread with its own worktree, and that
thread's agent may be mid-turn when the stack below it moves. So this design
answers four questions:

1. Who runs the engine?
2. How does a stack map onto threads?
3. How is a running agent asked before its branch moves, and what is it told
   afterwards?
4. Which tools and automation let agents drive the stack safely?

## 1. What exists

| Have | Where | Used for |
|---|---|---|
| Stack order inference | `pullRequestStackOrder()` in `packages/shared/src/pull-request-review.ts` (property-tested; used today by combined review) | Inferred stacks, and the differential test against the catalog |
| PR bases on every PR | `PrSummary.baseRefName` / `headRefName` (`packages/shared/src/contracts/navigation.ts`) | Inference and drift |
| Merge holds | `holdMerge` on `ThreadDependency`; `assertMergeNotHeld` in `apps/desktop/src/main/app-server/thread-dependency-merge-hold.ts`, called from `assertCanMerge` | Bottom-up merge order |
| `pr_merged`, `merge_build`, `ci_passed` conditions | `THREAD_DEPENDENCY_CONDITIONS`; evaluator `ThreadDependencyCoordinator` (`app-server/thread-dependency-coordinator.ts`) | Automatic sync after a parent merges |
| Turn holds with multiple reasons | `ThreadTurnQueue.heldQueues` (`packages/owner-core/src/thread-turn-queue.ts`) | Holding a layer thread during an apply |
| Act after the turn, then continue | `move_thread_workspace` (`app-server/thread-workspace-service.ts`) | The pattern for the restack handshake |
| Forge write policy | `FORGE_AGENT_WRITE_TOOL_GROUPS` (`packages/shared/src/contracts/forge-agent-tools.ts`), gate in `forge-tool-bridge.ts`; RBAC `tools.forge_write` | Gating stack writes and publishes |
| Merge-queue routing | `merge_pull_request` → `github-merge-queue.ts` | Merging layers |
| Per-repository mutation lock | `PerKeyAsyncLock` keyed by common git dir (`git-directory-service.ts` `worktreeMutationLocks`) | Serializing stack applies |
| Bundled Git 2.56.1 | `apps/desktop/custom-git-runtime.json` | `git replay` and `merge-tree --write-tree` everywhere |
| Thread grouping | `parentThreadId`, `subthreadOrder` (UI-only, per `navigation.ts`) | Presenting a stack as a tray |

Missing today, and harmful:

- An agent can rebase only its own worktree. The layers above it are checked out
  in other threads, and `rebase --update-refs` skips refs checked out elsewhere.
- `merge_pull_request` enables auto-merge while checks are pending under a merge
  queue. On a layer whose base is not trunk, that merges into the parent branch.
- After a parent merges, nothing retargets the layer above it. Whether GitHub
  retargets or closes that PR when the parent's branch is deleted depends on how
  the branch is deleted: an agent's `git push --delete`, repository auto-delete,
  or a GitHub stack that owns the bases.
- Nothing shows a stack. No `n/N` chip exists, the PR rail sorts by number, and
  the Star Map draws only federation links.

## 2. Facts from gh stack v0.3.0

Read from the source at `2a49e6751238633db504655d8a8eba3e433e827d`. These answer
PwrGit's open questions 1 and 2.

| Fact | Source | Consequence |
|---|---|---|
| Catalog at `<git-common-dir>/gh-stack`, schema 1; a newer version is a hard error | `internal/stack/stack.go` | Same as PwrGit: unknown schema → read-only |
| Catalog writes are SHA-256 compare-and-swap; it decodes into Go structs and re-marshals | `stack.go` (Save) | **Unknown fields are dropped.** PwrAgent stores nothing in the catalog |
| Two `flock` locks in the common dir: `gh-stack-operation.lock` (held for the whole command), then `gh-stack.lock` (catalog write). 100 ms retry, 5 s timeout, never unlinked | `internal/stack/lock.go`, `lock_unix.go`, `lock_windows.go` | Take them the same way, in the same order, and **only for the apply window**, never across a turn wait |
| Journals `gh-stack-rebase-state`, `gh-stack-modify-state`, `gh-stack-migration` block other mutations | `cmd/rebase.go`, `internal/modify/state.go`, `cmd/worktree_utils.go` | `gh_stack_busy` while any exists |
| gh stack rebases each branch in its own worktree, with `rebase.updateRefs=false`; preflight requires every involved worktree clean and not busy | `internal/git/git.go`, `internal/worktree/context.go` | Agrees with PwrGit's choice not to use `--update-refs` |
| Push: `--force-with-lease=refs/heads/B:<sha>` per branch, `--atomic` | `gitops.go` | Same as PwrGit's submit |
| Stack API: `GET/POST /repos/{o}/{r}/stacks`, `POST …/stacks/{n}/add`, `…/unstack`; 404 means the repository doesn't have stacks | `github.go` | Once linked, **GitHub owns PR bases**. gh stack never PATCHes them |
| Merge: `PUT /repos/{o}/{r}/pulls/{n}/merge-async` merges up to that PR, choosing between `merge_queue` and `direct_merge` | `merge.go`, `merge_async.go` | The linked-stack merge regime (§8) |
| Auto-merge is disabled on stacked PRs by `submit`; `link` rejects PRs that have it | `submit.go`, `link.go` | The P0 merge guard (§6.3) |

## 3. Decision: PwrAgent keeps its own copy of the engine

| Option | Verdict |
|---|---|
| A. PwrAgent orchestrates PwrGit's MCP `plan/apply` | Rejected. PwrGit is optional, desktop-only and must be running, while PwrAgent owners also run headless and as Outposts. The handshake would straddle two processes. Consent would happen twice. And PwrGit never session-grants `.publish`, so every automated sync would wait on a dialog in an app nobody is looking at. PwrAgent's main process doesn't call PwrGit tools today: `PwrGitConnectionService` only relays them to agents. |
| B. One engine as a shared package, linked by both apps | Rejected. The engine is a few thousand lines. Publishing, versioning and releasing a cross-repository package costs more than keeping two copies, and it would make each app's release wait on the other's. |
| C. Both, with a fallback | Rejected. Behaviour would depend on whether PwrGit is running. |
| **D. Copy the engine into PwrAgent** | **Recommended.** |

PwrAgent ports PwrGit's engine design (#646 §4) into
`packages/owner-core/src/stacks/engine/` and owns that copy. Whichever app
implements it first, the other copies the code. After that, each repository
fixes its own copy. Divergence is allowed. The tests in §11 keep both copies
honest against the same outside oracle, gh stack v0.3.0, and the same #586
fixture.

The copy talks to Git and to gh stack's catalog through two ports:

```ts
interface GitRunner {           // runGitCommand + bundled Git, in apps/desktop main
  run(cwd: string, args: string[], opts?: { stdin?: string }): Promise<GitResult>;
}
interface CatalogStore {        // gh stack's flock protocol (§2)
  withOperationLock<T>(commonDir: string, fn: () => Promise<T>): Promise<T>;
  read(commonDir: string): Promise<{ catalog: GhStackCatalog; sha256: string }>;
  writeIfUnchanged(commonDir: string, next: GhStackCatalog, sha256: string): Promise<void>;
}
```

Its API follows PwrGit's §4: `plan(op) → StackPlan` (replay + merge-tree
forecast, patch-id proof, dirty preflight, `expectedTips`), `apply(plan, hooks)`
(undo refs, one `update-ref --stdin` transaction, `reset --keep` per worktree,
catalog write), and `undo(opId)`. `hooks.beforeTransaction` is where the
coordinator re-plans after the threads are held (§5).

**Interoperating without shared code.** PwrAgent, PwrGit and gh stack share only
gh stack's catalog and its two `flock` locks, so any one of them serializes
against the others. Each app keeps its own journal and undo refs:
`$GIT_COMMON_DIR/pwragent-stack-op.json` and `refs/pwragent/undo/<op>/*` here,
PwrGit's `pwrgit-stack-op.json` and `refs/pwrgit/undo/*` there. Each app treats
the other's journal, while it exists, the way it treats gh stack's: the clone is
busy (`gh_stack_busy`, naming the app). Every apply is a compare-and-swap
against expected tips, so a stack moved by another tool is replanned, never
overwritten.

Layering: the engine lives in `packages/owner-core`, which already holds
host-independent owner services and ports. The `GitRunner` adapter lives in
`apps/desktop` main. Health and inference are pure functions in
`packages/shared`, so the renderer, main and Outpost compute the same answer.
The renderer gets everything else over IPC. `.dependency-cruiser.cjs` is
unchanged.

## 4. State

**Catalog.** gh stack's catalog, unmodified, written only under its locks (§2).

**Derived per layer** (a pure function of catalog, `git worktree list`, and
thread overlays, in `packages/shared/src/stacks/`):

| Role | Rule |
|---|---|
| Layer thread | The thread whose registered worktree (linked directory or `worktreeRegistrations`) has the branch checked out |
| Holder | For a branch checked out nowhere: the thread whose attached PR heads it, else the lead. It moves without a handshake |
| Ambiguous | The branch is checked out in two worktrees, or attached in two threads. Ref-moving plans are refused with `ambiguous_layer` |
| Remote | The layer's thread is on another instance. Read-only, `layer_remote` |

**Stored by PwrAgent:** only `stackLead` on the lead thread's overlay, which is
the thread that created or adopted the stack. Lead-ness moves with
`set_lead`, or passes to the bottom layer's thread when the lead is archived.
Nothing goes into the catalog: gh stack would drop it.

**Health** is PwrGit's table (in sync, needs restack, parent merged, needs push,
drift, remote ahead). PwrAgent adds two derived states: `held` (an operation is
waiting on this thread) and `ambiguous`. Precedence: catalog over the forge,
with disagreement shown as drift, never resolved silently. When the GitHub stack
is linked, its bases win over a PATCH.

**Inferred stacks.** A chain of open PRs that `pullRequestStackOrder()` accepts,
with no catalog entry, is shown dashed with **Adopt**.

## 5. The coordinator and the handshake

`StackCoordinator` lives in `packages/owner-core` beside `ThreadTurnQueue`. Every
ref-moving operation runs these steps in order:

1. **Plan.** The engine produces a forecast. No ref moves and no worktree is
   touched. The plan lists the affected layer threads and each one's state.
2. **Approve,** if the plan has publish or merge steps and policy says `ask`
   (§6.4).
3. **Hold.** For each affected layer thread, add the hold reason
   `stack-op:<opId>` to its turn queue. An idle thread is held at once. A
   running thread is held at its next turn boundary, before any queued send
   starts. "Running" is `isThreadActive`: an active turn, sub-agent, background
   task, or pending approval or input. There is **no default timeout**: the
   bound is the operator's to set. The operator can **Release this thread**,
   which drops that layer and every layer above it from the plan, or
   **Interrupt**, which stops those turns the way `stop_thread` does and records
   `interruptedBy`.
4. **Re-plan.** Holding takes time, and an agent may commit before its turn
   ends. Take the repository's `PerKeyAsyncLock`, then gh stack's operation
   lock, then plan again. If the forecast didn't change in substance, continue.
   If it did (a new conflict or a new publish step), release the locks **and
   the holds**, then return to step 2. No thread stays held while an approval
   is outstanding: holds are placed again after it's approved.
5. **Compare-and-swap and move.** One `update-ref --stdin` transaction against
   the re-planned `expectedTips`, then `reset --keep` in each held worktree,
   then the catalog write. Release gh stack's lock, then the repository lock.
6. **Notify.** Each moved thread gets one `StackNotice` (below).
7. **Release** the holds. Queued sends start, with the notice prepended.
8. **Publish,** if approved: leased atomic push, open or retarget PRs, then the
   Stack API `add` or a manual retarget (§8).

The caller's own layer moves under its own turn, because it asked. Its tool
result carries `moved: [{ branch, from, to }]`. Preflight still applies.

| Thread at apply | Outcome |
|---|---|
| Idle, no dirty overlap | Held, moved, released. The notice is a system item with the unread cookie. **No turn is started.** |
| Running | Waits for the turn boundary, then as above. The notice is prepended to the next turn's input. |
| Dirty overlap | Refused with `dirty_overlap`, naming the files. With `askToSettle`, one message asks the thread to commit or stash, and the plan is retried after its turn. |
| Locked (`thread.lock`) | Refused for that layer and the layers above it: `thread_locked`. |
| Remote or offline | `layer_remote`. |
| Archived, clean worktree | Treated as a holder, with no handshake. |

**`StackNotice`** (in `packages/shared/src/contracts/`, rendered under a new
`THREAD_STACK_NOTICE_INTRO` in `thread-system-messages.ts`):

```ts
type StackNotice = {
  opId: string; kind: "restack" | "sync" | "reorder" | "move_onto" | "fold" | "remove";
  stack: string; by: { threadId: string; actor: "agent" | "operator" | "automation" };
  branch: string; from: string; to: string; position: [number, number]; parent: string;
  below: { branch: string; added: number; removed: number; files: string[] }[];
  staleReads: string[];          // files the parent change touched ∩ files this thread read since its last notice
  proof: { patchIdsMatch: true; dropped: string[] };
  worktree: { followed: "reset --keep" | "not checked out"; keptDirty: string[] };
  interruptedBy?: "operator";
  undo: string;                  // refs/pwragent/undo/<opId>
};
```

The rendered text always ends with the same two sentences: don't rebase this
branch by hand, call `plan_stack_operation`; and reread the `staleReads` files
before relying on them.

**Crash recovery.** Holds are journalled with the operation. On restart, if the
journal shows the transaction hadn't run, release the holds. If it had, re-send
the notices (idempotent by `opId`), then release. A crash can't leave a thread
held forever.

## 6. Agent tools

### 6.1 New tools

All four go in the unified `pwragent` namespace, through the `forge` catalog
(`AGENT_TOOL_CATALOG_IDS`), so both the dynamic-tool and MCP paths expose them.
Schemas are `additionalProperties: false`, with no required context fields.
Caller identity comes from `AgentToolCallContext`. Results use
`agentToolSuccess`, and errors use `agentToolFailure({ code })`.

| Tool | Annotations | Group (default) |
|---|---|---|
| `list_stacks` | `readOnlyHint`, `openWorldHint` | `read` (allow) |
| `plan_stack_operation` | `readOnlyHint` (writes Git objects only), `openWorldHint` | `read` (allow); allowed in plan mode |
| `apply_stack_operation` | `destructiveHint`, `openWorldHint` | Chosen per call from the plan: `stacks` (auto) for local-only, `stack_publish` (ask) with push/forge steps, `approve_merge` (ask) for `merge` |
| `manage_stack_operation` | `destructiveHint` | `stacks` (auto) |

`plan_stack_operation` input (all optional except `operation`):

```ts
{
  stack?: string; branch?: string;            // stack by name or any member branch
  operation: "create" | "add_branch" | "adopt" | "restack" | "unstack" | "remove"
           | "reorder" | "move_onto" | "fold" | "submit" | "sync" | "merge";
  branches?: string[];                         // create / adopt, bottom first (adopt may omit: inferred)
  name?: string; newThread?: boolean; carryChanges?: boolean;   // add_branch
  from?: string;                               // restack this layer and above (default: all stale)
  order?: string[];                            // reorder, bottom first
  onto?: string;                               // move_onto
  mode?: "detach" | "forget";                  // remove
  upTo?: string;                               // merge everything up to this layer
  draft?: boolean;                             // submit; default true
  waitForTurns?: "wait" | "ask";               // ask = steer_thread running layer threads to end their turn
  askToSettle?: boolean;
}
```

Result: `{ planId, steps[], forecast: { [branch]: "clean" | { conflict: { commit, files } } },
affected: [{ threadId, title, branch, state, needs: "none" | "hold" | "wait_turn" | "blocked" }],
expectedTips, push[], forge[], approval: "none" | "stack_publish" | "approve_merge" | "disabled" }`.

Advertising: `apply_stack_operation` is advertised while at least one of
`stacks`, `stack_publish` and `approve_merge` isn't `off` for the caller. A call
whose plan needs an `off` group fails with `tools_disabled`, naming the group.
`plan_stack_operation` reports that ahead of time as `approval: "disabled"`.

`apply_stack_operation` takes `{ planId }`, or `{ operation, … }` to plan and
apply in one call when the forecast is clean and no approval is needed. It
doesn't block on other threads: it returns
`{ opId, status: "waiting" | "running" | "paused" | "done" | "needs_approval", waiting?: [{ threadId, reason }] }`.
The caller learns of completion through `manage_stack_operation status`, or
through `watch` semantics shared with `watch_thread_pull_request`.

`manage_stack_operation`: `{ opId, action: "status" | "continue" | "abort" | "undo" | "release_thread", threadId? }`.
A layer thread calls `continue` after it resolves a conflict it was routed (§9).

Failure codes: `stale_plan`, `forecast_conflict`, `dirty_overlap`,
`thread_locked`, `gh_stack_busy`, `remote_diverged`, `ambiguous_layer`,
`layer_remote`, `catalog_schema_unknown`, `publish_denied`, `stack_owns_base`,
`stack_parent_open`, plus the gate's existing `plan_mode` and `tools_disabled`.

Registration: entries in `SEARCH_ALIASES` (`pwragent-tool-search.ts`) for
"stack", "restack", "gh stack", "rebase stack", "stacked PR"; one sentence in
`buildPwrAgentMcpInstructions`; a "Stacked PRs" section in the bundled
`skill://tool-guide`. The frozen legacy namespaces get nothing.

### 6.2 Operations

PwrGit's §5 table applies unchanged. PwrAgent adds:

- `create` and `add_branch` with `newThread: true` create the layer thread as a
  sub-thread of the lead (`parentThreadId`), in a new worktree, and arm the
  layer's dependency (§8).
- `adopt` writes the catalog for an inferred or named chain, and arms
  dependencies. It does **not** reparent threads. Grouping is the operator's.
- `remove` with `forget` changes only the catalog; with `detach` it is a restack
  that drops that layer's commits from the layers above.
- `submit` attaches each new PR to its layer's thread, as `create_pull_request`
  does today (`attachedToThread`).

### 6.3 Existing PR tools

Per `agent-tool-contracts.md`, no existing field changes meaning.

- **`create_pull_request`:** `base` still defaults to the default branch. When
  `head` is a layer, the result gains
  `stack: { name, position, expectedBase, drift }`, and the catalog records the
  PR under the lock.
- **`update_pull_request`:** a `base` that disagrees with the catalog still
  succeeds, and the result gains `stack.drift: true`. When the GitHub stack owns
  bases, it is refused with `stack_owns_base`.
- **`merge_pull_request`:** `assertCanMerge` adds `stack_parent_open`. A layer
  merges only when every layer below it has merged and its GitHub base is trunk.
  This also stops the queue path from enabling auto-merge on a non-trunk base.
  This is a fix to today's behaviour, so it ships in P0 with a property test that
  fails on current `main` (§11).

### 6.4 Policy and RBAC

`FORGE_AGENT_WRITE_TOOL_GROUPS` gains `stacks` (default `auto`) and
`stack_publish` (default `ask`). `apply_stack_operation`'s group depends on its
plan, the same way `forgePrToolGroup` moves approving reviews to
`approve_merge`. The existing test that `FORGE_PR_WRITE_OPERATIONS` equals the
map's keys extends to the new tools. Messaging-started turns map through
`isForgeWriteToolName` to `tools.forge_write`.

PwrGit's rule is that a session grant never covers `.publish`. PwrAgent's
equivalent is the per-project, per-agent rule `[[git.agent_tools.rules]]`: an
operator who writes `stack_publish = "allow"` for one repository and agent has
made a standing grant. That decision belongs to the operator, not to a
hard-coded rule. The approval card itself is the existing MCP approval card
(`.transcript-mcp`) rendering the plan, with **Deny**, **Local only** and
**Approve**. Local only applies the ref moves and returns the publish steps as
not done. That is a partial result, not an error.

## 7. Threads and sub-threads

- New layers are created as sub-threads of the lead. PwrAgent writes their
  `subthreadOrder` top-first, so the tray reads like GitHub's stack.
- Adopted layers stay where they are. **Group as stack** is a separate, explicit
  operator action.
- Inside a stack tray, the pointer drag (`useSubthreadReorderDrag`) shows the
  held card as **Plan reorder**. Dropping stages a reorder plan, and the rows
  snap back to catalog order until it is applied. Dropping outside the tray
  detaches the sub-thread and leaves the stack untouched.
- A stack belongs to one clone: the instance whose `$GIT_COMMON_DIR` holds the
  catalog. A layer thread handed off to another instance is read-only
  (`layer_remote`) until it returns or pushes.

## 8. Automation

**Dependencies.** Creating or adopting a stack arms, for each layer *k* > 1, a
`ThreadDependency` on layer *k*'s thread with:

- `conditions: [{ when: "pr_merged", threadId: <layer k−1>, prUrl: <its PR> }]`
- `holdMerge: true`, `automatic: true`
- continuation `stack:sync`, a structured marker rather than prompt text.

When the dependency fires, `ThreadDependencyCoordinator` hands the
`stack:sync` continuation to `StackCoordinator` instead of calling
`buildDependencyPrompt`. The sync plan runs through §5. The layer thread is
woken by its notice after the sync, not before. A project can choose
`merge_build` instead of `pr_merged`, so the layer waits for main's post-merge
build before it restacks onto main. Restacks, reorders and removals re-arm the
affected dependencies, using the existing `supersededBy` path.

**Sync and retargeting.** PwrGit's §4 sync: replay `--onto trunk <parent's last
tip>`. Then:

- **Linked on GitHub:** don't PATCH bases. GitHub's stack retargets them. Update
  the stack with the Stack API.
- **No Stack API (404):** retarget the child to trunk **before** anything
  deletes the merged branch. GitHub's own retarget-on-delete depends on how the
  branch is deleted, and PwrAgent doesn't rely on it, so no layer is ever left
  based on a branch that no longer exists.

**Merging a whole stack** (`operation: "merge"`, group `approve_merge`):

- **Linked:** `PUT /repos/{o}/{r}/pulls/{upTo}/merge-async`, with
  `merge_action` chosen like gh stack (`merge_queue` or `direct_merge`), after
  checking every layer's head against `expectedTips`. One approval.
- **Not linked:** walk the chain. Merge the bottom with `merge_pull_request`
  (sha-pinned, queue-aware); `pr_merged` fires; sync; `ci_passed` on the next
  layer; then merge it. `holdMerge` keeps every upper layer out of the queue
  until its turn. The operator approves once for the chain, and each step's
  card lists the follow-through it covers.

**`prAutomation.guidance`.** `getThreadPullRequestAutomationStatus` prepends
one sentence for a stacked PR, built by the same health function as the chips:

> #652 is layer 2 of 4 in stack windows, based on windows/model (#651). PwrAgent
> holds its merge until #651 merges, then syncs this branch onto main, retargets
> #652, and tells you what moved. Don't rebase, retarget, or merge it yourself,
> and don't enable auto-merge: call plan_stack_operation.

`describePrReviewReadiness` stops offering a merge card for a non-bottom layer.

## 9. UI

Every surface reuses a shipped primitive at its shipped size. The board's turn 3
has each one.

- **Thread rows.** A new position chip (`2/4`) in `.thread-row__chips`. It is
  20px tall like every row chip, neutral per UI-THEME's "one signal per row",
  `--warn-text` only when stale, and `--essential` under Minimal density. In a
  stack tray, `.subthread-list`'s `border-left` becomes a 1.5px spine at 55%
  accent, with dashed `--status-warning` segments where a layer is stale. The
  `held · restack` chip uses the queued-message held styling. The chip opens
  the stack in the PR rail.
- **PR rail.** A Stack card (`.rail-card`) above the PR cards. It lists the
  layers with their threads and has Restack, Sync and Submit. While an operation
  runs, the same card shows the plan, the approval and the proof ledger. The PR
  cards sort with `orderPullRequestSet()` when their bases chain.
- **Waiting for.** The automatic dependency appears in Other threads with the
  phrase "stack windows 2/4 → 3/4 · holds this PR's merge". A held operation
  appears as a hold notice with **Open plan** and **Release this thread**.
- **Star Map.** A new `svg.star-map__stacks` layer under the cards draws
  parent → child edges. Edges are solid at the healthy link's 55% accent,
  dashed `--status-warning` where a layer is stale, and `--brand-purple` as a
  merged layer leaves. The edge being replayed carries a flowing dash, which
  is hidden under reduced motion so the edge keeps its stale dashing.
  `highlight_star_map_threads` accepts a stack.
- **Motion.** Cards re-seat in 360 ms on `cubic-bezier(.2, .8, .2, 1)`. The
  replayed branch carries an amber line. A restacked wire draws solid in 420 ms.
  Running threads show `ThinkingScanner`. Under `prefers-reduced-motion`,
  everything stops except the scanner, which **holds** mid-sweep as
  `desktop-style-guide.md` requires. The Star Map's flowing dash is hidden.
  Under Calm motion, the loops run twice and rest. New loops get entries in
  `reduced-motion-contract.test.ts` and `calm-motion-contract.test.ts`.

## 10. Failure paths

| Case | Behaviour |
|---|---|
| Conflict in another thread's layer | The plan stops before that layer, and nothing moves. The operator or the caller chooses: apply only the clean layers below; route the conflict to the owning thread with `send_message_to_thread` (the conflicting commit, the files, and the parent change), which resolves it with a real `rebase --onto` in its own worktree and calls `manage_stack_operation continue`, after which the rest re-plans from its tip; or abort. If the owner is archived, the lead resolves it in a disposable worktree. |
| Two agents race | Applies serialize on the repository's `PerKeyAsyncLock`, then compare-and-swap in `update-ref`. The loser gets `stale_plan` with the refs that moved. A re-plan with an unchanged forecast applies once on its own. A changed one goes back to the caller. |
| gh stack or PwrGit mid-operation | A gh stack journal or PwrGit's `pwrgit-stack-op.json` present, or the operation lock contended, gives `gh_stack_busy`, naming the tool and the worktree. PwrAgent never breaks a `flock` or deletes a journal. |
| Remote moved | If local is an ancestor of remote, the plan fast-forwards first. If they diverged, it's `remote_diverged`: nothing is pushed, and the layer thread is asked to integrate the remote commits. |
| Lease fails | `--atomic` means nothing moved on GitHub. Re-fetch and re-plan the push steps, with a new approval if the push list changed. |
| Quit mid-operation | Journal replay (§5). |

## 11. Tests

Per [property-model-oracle-testing.md](../property-model-oracle-testing.md):

- **Model test of `StackCoordinator`** with `fc.commands` and `fc.scheduler`.
  Commands: agentCommit, turnStart, turnEnd, plan, apply, interrupt,
  releaseThread, remotePush, merge, ghStackLock, crash. Invariants:
  - no worktree moves while its thread is active, unless it is the caller or was
    interrupted;
  - refs move all or none;
  - each moved thread gets exactly one notice per operation;
  - every hold an operation placed is released by done, abort or restart;
  - gh stack's operation lock is never held across a turn wait;
  - other stacks in the catalog are byte-identical after a write.
- **Property: layer binding.** The derivation is independent of input order, and
  every branch has at most one owner or is marked ambiguous. The oracle is
  brute-force enumeration.
- **Differential: inference vs. catalog.** For any catalog whose PRs exist with
  matching bases, `pullRequestStackOrder()` returns the catalog's order.
  Otherwise, health reports drift.
- **Property: merge guard (P0 fix).** For random stack states, merge and
  auto-merge are allowed only for the lowest unmerged layer with base = trunk.
  This must fail against current `main`.
- **Oracle: gh stack v0.3.0.** A catalog written by PwrAgent reads back unchanged
  through `gh stack view --json`. A child process holding `flock` makes PwrAgent
  refuse, and never makes it break the lock. The #586 shape reuses
  `scripts/diagnostics/gh-stack-stale-boundary`. Skipped, with a visible reason,
  where the extension isn't installed.
- **Engine tests** come with the copy: PwrGit #646 §8's model test, atomicity
  fault injection, forecast soundness and the #586 regression run against
  PwrAgent's copy in `packages/owner-core`. They are what keeps the two copies
  honest without shared code.

## 12. SQLite write budget

Per operation: one notice item per moved thread, plus one operation record on
the lead. Plans, holds and forecasts live in memory and in the engine's journal.
Example: a 4-layer stack restacked 30 times a day writes about 120 commits. The
known baselines in
[sqlite-write-volume.md](../../apps/desktop/docs/sqlite-write-volume.md) put a
commit at 3.7–18 KB of WAL. That gives about 0.5–2 MB/day, against ~65 MB/day
for the retired lease heartbeat. The budget JSON gets one line per operation
kind, measured with `measureSqliteWrites`, and the real figure replaces this
estimate.

## 13. Phasing

| Phase | Ships | Gate |
|---|---|---|
| P0 | Catalog reader, health and inference in `packages/shared`; position chips, tray spine, PR rail card, Star Map edges; `list_stacks`; the `stack_parent_open` merge and auto-merge guard; the stacked guidance sentence | No engine needed. The merge-guard property test fails on `main` first. |
| P1 | `plan`/`apply` for `restack`, `add_branch`, `adopt`, `remove`; the coordinator and handshake; notices; undo | The engine copied into `owner-core` with #646 §8's model and atomicity tests. Coordinator model test. |
| P2 | `submit`, `sync`, automatic dependencies, `stack_publish` with approval, Stack API link with 404 fallback | gh stack oracle tests. Stack API confirmed for the org. |
| P3 | Drag-to-plan reorder, `move_onto`, `fold`, `merge` in both regimes | PwrGit's forecast-soundness property. |

## 14. Open questions

1. Which app builds the engine first? The other copies it, so the first one
   should land with the model, atomicity and gh stack oracle tests the second
   copy will reuse.
2. Is GitHub's Stack API (`/stacks`, `merge-async`) enabled for the org? A 404
   from the list call means it isn't.
3. Should a notice to an idle thread ever start a turn? The proposal is no.
4. Should approving a merge also cover its mechanical follow-through (retarget,
   replay and leased push of the layer above)? The proposal is yes, with that
   follow-through listed on the card.
5. Should one stack span instances? The proposal is no: a stack belongs to one
   clone.
