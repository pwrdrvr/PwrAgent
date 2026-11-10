# PWR-139 shared owner read model verification

Recorded on 2026-11-10. The implementation is commit
`0fac6d0deab9d17bc10ce651bf1f7fd415954330`, rebased on main
`24606f456b81735f0755c93957bb2ed68285a60a`.

## Live on the Docker Outpost

The existing Outpost identity was retained:
`4f9b407d-2bb9-4893-9b98-28b88952a3de`. The existing named container,
volume, relay, unprivileged user, dropped capabilities, seccomp profile and
no-new-privileges setting were retained. Codex used workspace-write with
approval policy never. No additional Outpost identity was provisioned.

| Component | Observed version |
| --- | --- |
| Outpost | 1.3.16 |
| Codex CLI | 0.159.2 |
| Docker | 29.8.1, linux/arm64 |
| Image tag | `pwragent-outpost:pwr139-0fac6d0de` |
| Image ID | `sha256:6bc5ccc491d527dc643edfdad0a9a0402f409a3c1c6e298f253c8ea6d3efae72` |

The image's source-commit label is the implementation commit above. The
container was left running that image after the demo.

The real Codex demo thread is `01a1c633-c186-7fe1-8d84-64e1a21e030d`, titled
**PWR139 owner demo fixture**, in the hello-world project. Its model is
`gpt-6.1-sol`, reasoning effort `low`, execution mode `auto`.

| Observation | Evidence source | Result |
| --- | --- | --- |
| Attention scan during execution | `list_attention_threads` | Demo row had `running: true`, `unread: true`, `needsInput: false`. |
| Distinct turn accepted while the first ran | `send_message_to_thread`, `delivery: new_turn` | `queueStatus: queued`, with `queueEntryId` below. |
| Queued turn executed after the first | `read_thread` and the contrived workspace file | Reply `PWR139-QUEUED-DONE`; the file contained the first marker before the queued marker. |
| Attention scan after completion | `list_attention_threads` | Demo row had `running: false`, `unread: true`, `needsInput: false`. After the later order-check turn, it was first in the returned Attention rows. |
| Model and effort | `get_thread_status` | `gpt-6.1-sol`, `low`, `auto`. Shared row-field parity is also checked by the owner oracle. |
| Federated search | `search_federation_threads`, query `PWR139 owner demo`, remote scope | One result; the Outpost appeared in `searchedInstances`, with no failures. |
| Operator focus | `read_operator_focus` | The operator had another thread selected outside Attention; the demo thread was not focused. |

The accepted queue entry was
`fed-853b738bff27a7b4afe9fffdb6fe7a12c2abc8e0db0df2a78c148fc1932a735c`.
The owner queue-resource oracle checks the cursor and queued row used by the
queue strip. No queue-strip pixels were captured.

The contrived file `pwr139_owner_demo.txt` contained, in order:

```text
PWR139-FIRST-DONE
PWR139-QUEUED-DONE
PWR139-PROMOTED-DONE
PWR139-ORDER-DONE
```

The three older placeholder threads were read through the protocol after the
new build started. All three acquired Codex preview titles:

| Thread | Title after reading |
| --- | --- |
| `01a19880-b1fb-7c22-a67d-24d7fc27fe0e` | Authorized isolated smoke test. In the current directory only... |
| `01a19875-c642-72a0-84f7-6b7f3841018a` | This is an authorized isolated Docker smoke test of the published... |
| `01a17d83-3639-7f21-85f7-5246e9bb7473` | This is an isolated PwrAgent Docker smoke test... |

These observations establish owner state as seen through desktop tools. They
do not establish renderer focus behavior or a raw live event stream.

## Owner oracles

The conformance suite compares desktop and Outpost summaries, navigation rows,
selected detail, collections, queue projection, seen state and lifecycle
events. It now permits only 18 explicitly named backend-feature differences.
The generated history oracle covers canonical model/effort, rename, seen and
search behavior. A separate property checks that provisional and provider turn
IDs produce the same Attention rank, including turn-end promotion.

Before the fix, the strict conformance oracle reported 36 required differences;
the generated history and provisional-turn properties also failed. The seen
burst property measured 100 commits where its rule requires one. All pass on
the implementation. Events are owner-side oracle evidence, not a captured live
desktop event stream.

## Renderer tests

`useThreadNavigation.test.tsx` checks that focus in Attention preserves unread,
the reply path's `markThreadsSeen` call clears unread, and leaving Attention
clears unread for the focused thread. The focused run passed three tests (235
unrelated tests were skipped). This is hook-level policy coverage; the accepted
send boundary remains in the manual check. A mark-seen mutation was not used as
proof of UI behavior.

The operator's manual check remains:

1. Open thread `01a1c633-c186-7fe1-8d84-64e1a21e030d` on Outpost `4f9b407d`
   in Attention. The cookie stays.
2. Reply. The cookie clears after the send is accepted.
3. Repeat in Inbox. The cookie clears on focus.

## SQLite write budgets

The checked-in budgets measure the feature after setup:

| Workload | Commits | Observed WAL bytes |
| --- | ---: | ---: |
| 100 seen acknowledgments inside one stamp interval | 1 | 12,360 |
| 100 passive owner read-model cycles | 0 | 0 |
| First provider discovery with unread-baseline initialization | 2 | 16,480 |

Discovery previously used one commit / 8,240 WAL bytes. The added baseline
commit occurs once per profile. There are no timer writes. For an unchanged
watermark acknowledged continuously, the five-minute stamp interval permits
288 commits/day: `288 × 12,360 = 3.56 MB/day`, using decimal MB. At one
acknowledgment per second, the former per-command write rate would project to
about 1,068 MB/day at this measured commit cost. New watermarks still require
writes. Passive reads project to 0 MB/day.

## Local verification

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` in this worktree | Passed |
| `pnpm lint:oxlint` | Passed, existing warnings only |
| `pnpm lint:oxlint:typed` | Passed |
| `pnpm lint:boundaries` | Passed, no boundary-rule changes |
| `pnpm lint:sql` | Passed |
| `pnpm typecheck` | Passed |
| Owner conformance | 78 passed |
| Owner-core package tests | 202 passed |
| Outpost package tests, `pnpm --filter pwragent test` | 129 passed |
| Focused changed-rule root tests, nine files | 83 passed |
| Focused renderer unread tests | 3 passed |

The broad root Outpost batch was not green: the main comparison had 10
five-second deadline failures (153 passed); the branch batch had 18 (146
passed). These runs used the existing deadlines, isolation and worker settings.
The operator also identified existing main deadline failures in
outpost-profile-parity, shared-messaging-request-storage and
worktree-maintenance-registration. No deadline workaround was made. CI runs
the full suite; Electron E2E was not run on this Mac, as instructed.

## Deletions

Relative to main, `federation-backend.js` has 127 additions and 167 deletions
(net -40): its handwritten summary/navigation projection, queue cursor,
headless-event translation, synthetic Attention events and legacy metadata
mutation paths were replaced with shared owner paths.
`backend-registry.ts` has 2 additions and 100 deletions (net -98). The retained
owner's third unread calculation and the reverse legacy projection were also
removed; only the one-time JSON import conversion remains.
