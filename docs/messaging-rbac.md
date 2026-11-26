# Messaging RBAC: Roles, Permissions, and Access Control

PwrAgent gates what a messaging-platform actor may do through an additive,
AWS-IAM-style role-based capability system (issue #260). RBAC is a **second
authorization layer that composes with — and never replaces — the provider
admission gate**: the platform adapter still decides *"may this actor reach
the bot at all"* (authorized user lists, Slack access modes), and RBAC decides
*"what may an admitted actor do"*.

The single source of truth for the permission catalog, built-in roles, and the
pure resolution engine is
[`packages/shared/src/contracts/rbac.ts`](../packages/shared/src/contracts/rbac.ts).
It lives in `@pwragent/shared` so the desktop main process (enforcement) and
the renderer (the Access Control graph) import one implementation without a
dependency-boundary violation. This document is the operator/contributor-facing
description of that contract.

## Permission catalog

Permissions are atomic capability IDs. **They are contractually load-bearing:
once shipped, a permission ID must never change meaning**, because custom role
definitions persist the IDs under `[messaging.rbac]` in the per-profile
`config.toml`. Add new IDs;
never repurpose old ones. Keep this table, the `MessagingPermissionId` union,
and `MESSAGING_PERMISSION_CATALOG` in lockstep (a drift-guard test in
`apps/desktop/src/main/__tests__/rbac-permission-coverage.test.ts` enforces the
code side).

| Permission ID | Group | What it gates |
|---|---|---|
| `message.reply` | conversation | Send a plain message turn to a bound thread. The baseline floor. Also gates `send_messaging_file`, listing/exporting the actor's received originals in that thread, and Claude's "Continue in a new session" recovery (`/continue`). |
| `elicitation.answer` | conversation | Respond to the agent's elicitation prompts (questionnaire buttons + freeform fallback). |
| `thread.status.view` | session | Read the binding status card and transcript. |
| `thread.resume` | session | Attach the conversation to an existing thread (`/resume`, `/agent`, and the agent-driven `attach_thread_here`). |
| `thread.new` | session | Open a new thread from a project (`/new`). |
| `thread.detach` | session | Unbind the conversation from its thread. |
| `thread.monitor` | session | Watch recent threads once per minute (`/monitor`). |
| `thread.settings.model` | settings | Set the thread's model (and service tier). |
| `thread.settings.reasoning` | settings | Set the thread's reasoning effort. |
| `thread.settings.fast_mode` | settings | Toggle fast mode. |
| `thread.settings.tool_updates` | settings | Set how tool activity streams. |
| `thread.settings.streaming` | settings | Set how responses stream. |
| `thread.settings.response_mode` | settings | Set whether the bot answers every message or only when mentioned (affects the whole conversation). |
| `thread.settings.permissions_mode` | settings | Switch the sandbox/default permissions mode (non-full-access targets only). |
| `thread.settings.execution_mode` | settings | Switch the sandbox/network execution mode (non-full-access targets only). |
| `thread.settings.name` | settings | Sync or agent-rename the current messaging conversation. |
| `thread.settings.skills` | settings | Open the skills browser and change enabled skills (all `skills:*` sub-actions). |
| `thread.control.stop` | control | Interrupt the running turn. |
| `thread.control.compact` | control | Compact the thread's context. |
| `thread.control.handoff` | control | Move a thread between local/worktree/branches (all `handoff:*` actions), or to another project (`mutate_thread` `projectPath`). Lock or unlock a thread (the status card's Lock/Unlock toggle, `status:lock`, and `mutate_thread` `locked` and `lockNote`). |
| `thread.control.archive` | control (danger: med) | Let the agent archive a thread (`mutate_thread` `archive: true`), removing the worktrees PwrAgent created for it, or restore an archived one (`archive: false`). Also gates `apply_thread_maintenance`, which archives idle threads and removes archived checkouts from a reviewed scan after the operator confirms a card. A handoff card's **Unlock and Hand Off** (`handoff:confirm-unlock`, or any handoff request carrying `approvedLockReason`) needs this as well as `thread.control.handoff`: it clears a Git worktree lock someone else set. The button is not shown without it, and the callback is refused. Agents never unlock; `mutate_thread` archive reports a locked worktree as kept. Admin only by default. |
| `thread.control.organize` | control | Let the agent pin or unpin a thread (`mutate_thread` `pinned`), mark it read or unread (`unread`), group it under another thread as a sub-thread or make it top-level again (`parentThreadId`, `parentBackend`, `detachFromParent`), and mark an entire project read (`mark_project_read`). |
| `thread.control.schedule` | control | Queue a message to the bound thread for later (`/schedule`), list or cancel the queue (`/scheduled`), and let the agent schedule, list or cancel a follow-up for the thread (`schedule_follow_up`). The woken turn keeps the asking contact as its source, so its tool calls are checked against that contact's role when it fires. |
| `approval.respond.default` | interactive | Approve or deny non-escalation approval requests. |
| `approval.respond.escalation` | interactive (danger: med) | Approve or deny network / exec / filesystem escalation requests. |
| `tools.thread_inspection` | tools (danger: med) | Let the agent search and read OTHER threads on the actor's behalf (`search_threads`, `read_thread`, thread status, PR inspection, `read_star_map_view`), point the desktop Star Map at them (`fly_star_map_to`, `highlight_star_map_threads`, `set_star_map_view`), scan for idle threads (`scan_thread_maintenance`), and open the desktop Thread maintenance dialog (`open_thread_maintenance`). |
| `tools.thread_orchestration` | tools (danger: med) | Let the agent inject messages into other threads, hand off tasks, attach directories, and attach PRs. |
| `tools.instance_management` | tools (danger: med) | Let the agent manage PwrAgent itself and inspect automations (`manage_pwragent`). |
| `tools.instance_lifecycle` | tools (danger: high) | Additional explicit grant for `manage_pwragent`, including status. Requires a designated Agent thread and a retained actor whose current provider access is verified. Admin is the only built-in role granting it. Power User + Tools does not. |
| `tools.messaging_profile_settings` | tools (danger: med) | Read and change the profile default for Development-thread Working Updates. Requires an attributed, active local messaging turn and current provider and RBAC admission. Admin is the only built-in role granting it. |
| `tools.forge_write` | tools (danger: med) | Let the agent use the operator's GitHub or GitLab account to open, edit, review, and merge pull requests or merge requests, create and edit issues, post comments, resolve review threads, and rerun failed CI jobs. Granted to Admin and Power User + Tools. See [Agent forge tools](forge-agent-tools.md). |
| `thread.execution.full_access` | danger (danger: high) | Select or resume into full-access execution — near-complete control of the host. |
| `federation.remote_control` | danger (danger: high) | Browse and drive threads that live on federated peers, not just this machine. Required *in addition to* the action's own permission — see "Federation scope" below. |

Notes on the danger tiers:

- The `tools.*` permissions govern agent actions on behalf of the messaging
  user, including cross-thread access, instance and profile management, and
  forge writes. Forge reads use `tools.thread_inspection`. Forge writes use
  `tools.forge_write` and remain subject to the
  [agent forge tool policy](forge-agent-tools.md).
- `mutate_thread` is gated **per field** at parity with the status-card
  buttons (`permissionsForThreadMutation`), including the full-access danger
  gate for `executionMode: "full-access"`. `archive` has no status-card
  button to match, so it has a permission of its own rather than riding on
  `thread.control.handoff`: it removes worktrees, which holding handoff has
  never implied. A restore (`archive: false`) asks the same permission,
  since it brings those worktrees back. `pinned` and `unread` have no
  status-card buttons either; they share `thread.control.organize`, which
  Power User holds, because they change how the operator's list is sorted
  and nothing about the thread's work.
- `thread.execution.full_access` is escalation-equivalent. It **double-gates**:
  the RBAC permission is required *in addition to* the existing global
  full-access toggle, never as a bypass of it.

## Built-in roles

Built-in roles ship as code constants (never persisted) and their IDs are
reserved: `admin`, `power_user`, `power_user_tools`, `chat_user`,
`limited_chat_user`.

| Role | Permission set | Intent |
|---|---|---|
| **Admin** | The whole catalog, computed — it can never silently miss a newly added capability. Includes `federation.remote_control`, so Admin is the only built-in that reaches other instances. | The operator's own accounts. |
| **Power User** | Everything a thread operator needs EXCEPT `approval.respond.escalation`, `thread.control.archive`, the `tools.*` agent surface, and full access. Enumerated explicitly so new permissions are opt-in. | A trusted colleague driving their own threads. |
| **Power User + Tools** | Power User plus `tools.thread_inspection`, `tools.thread_orchestration`, `tools.instance_management`, and `tools.forge_write`. | A Power User also trusted to let the agent operate across local threads, manage this instance, and make GitHub or GitLab changes. |
| **Chat User** | `message.reply`, `elicitation.answer`, `thread.status.view`. | Converse and observe; no control surface. |
| **Limited Chat User** | `message.reply`, `elicitation.answer`. | Reply and answer questions only. |

Two deliberate calls reviewers should know about (both one-line changes if
policy shifts): escalation approvals are **Admin-only** (Power User holds
`approval.respond.default` but not `.escalation`), and `elicitation.answer`
**is** kept for Limited Chat User so button-driven questionnaires keep working.

Custom roles can bundle any subset of the catalog under an operator-chosen
name. A custom role that includes `thread.execution.full_access` is
auto-marked dangerous and requires the typed acknowledgment (below).

## Subjects and attachments

Roles attach to **subjects** per platform:

- **Actor subjects** — a specific platform user ID (e.g. one Slack member).
- **Bucket subjects** — the whole set of admitted-but-unnamed actors a Slack
  access mode lets in: `channel_any_user` (from
  `channelUserAccessMode: "any_channel_user"`, optionally scoped to a single
  channel via `scopeId`) and `dm_any_workspace_user` (from
  `dmAccessMode: "any_workspace_user"`). Buckets make the "oops, this is wide
  open" failure mode visible and cappable — a channel member can be held to
  Chat User while named colleagues keep Power User.

A bucket attachment only matches when the actor was actually **admitted via
that path** — a named authorized user is not silently widened by a bucket
role, and a bucket role never applies on a platform other than its own.

Two operator consequences of that rule are worth internalizing:

- **A contact authorized *after* enforcement was enabled starts with zero
  permissions.** The Admin seed only runs at enable time, so a newly added
  `authorizedUserIds` contact is admitted by the provider but default-denied
  by RBAC until you attach a role — the Access Control pane shows them wired
  to the REJECTED sink.
- **Named actors can have *less* capability than the bucket around them.**
  Because bucket roles never widen named actors, a role-less named actor in a
  bucket-enabled Slack channel is denied while their unnamed peers chat via
  the bucket role. That asymmetry is deliberate — naming someone gives them an
  individually controlled grant, not the crowd's — but it can look like a bug
  if you don't expect it.

## Resolution semantics

- **Strictly additive.** An actor's effective permission set is the UNION of
  every role reachable from every matching attachment. There are no deny
  rules — to remove a capability, remove the role (or the role's permission).
- **Default deny.** An actor matching no permission-granting role gets an
  empty set and is rejected with an audit entry.
- **Legacy-compatible mode.** When enforcement is off (or no policy file
  exists), every provider-admitted actor is implicitly Admin — byte-for-byte
  the pre-RBAC behavior. Enabling enforcement seeds actor→Admin attachments
  for every currently authorized contact (plus bucket review rows) so nobody
  loses access; the seed only applies when the policy has no attachments yet,
  so re-toggling never clobbers edits.

## Enforcement surfaces

`manage_pwragent` requires both instance permissions through the canonical
resolver. Its stricter lifecycle gate denies legacy/non-enforcing policy,
unattributed desktop turns, missing actor provenance, and ordinary coding or
handoff threads. An actor or custom role named “owner” confers no authority by
name; a custom role needs explicit grants. The local provider transport supplies
thread/turn identity. Discovery and execution re-resolve the persisted Agent
designation and retained actor, including after response acknowledgement.

An app update card requires the same two permissions. It resolves the actor
from the provider callback, so neither tap starts an Agent turn. The owner
checks the current provider account, conversation membership, local binding,
and opt-in on every tap and again before installation. The confirmation
belongs to the actor who opened it. An authorized actor in another conversation
showing the same pending update can cancel the wait. The native installer runs
once the owner is idle, including the initiating Agent's queue. Open terminals
also block a chat-requested restart.

`get_messaging_working_updates_default` and
`set_messaging_working_updates_default` use the current messaging request on
the owner serving the profile. An explicitly granted actor can use an active
bound conversation or a current default Agent route. Legacy implicit Admin,
unattributed desktop and completion turns, and federation calls cannot use
these tools. The profile default affects Development bindings that inherit
it. Existing binding selections and project launch settings keep precedence.
New Development threads launched from messaging retain the resolved selection
they start with, as before. The Agent-thread default and default route
settings have their own controls. For example, ask an authorized messaging
Agent “Set the default Working Updates for bound Development threads to None.”

Action enforcement funnels through `MessagingAccessControl.requirePermission` in
[`messaging-access-control.ts`](../apps/desktop/src/main/messaging/core/messaging-access-control.ts).
The controller routes commands and callbacks through late-bound owner ports and
retains the public dynamic-tool authorization facade:

- command dispatch (`/resume`, `/new`, `/status`, `/detach`, `/monitor`, …;
  `/help` is deliberately ungated),
- a single top-guard on every status-card / handoff / questionnaire callback,
- the approval branches, split between `approval.respond.default` and
  `approval.respond.escalation` by the pending request's kind (fail-closed:
  an approval that cannot be classified requires the escalation permission),
- the `message.reply` floor for plain turns,
- `/review` and the review picker's Start action require `message.reply`.
  A PR review on a peer also requires `federation.remote_control`,
- Claude's deleted-session recovery button and `/continue`, also gated on
  `message.reply`. The backend refuses while Claude still has the session or
  the thread is busy or locked; recovery preserves messages and execution
  settings. It therefore needs no additional session-control permission.
  Like desktop recovery, it runs only on the thread's owning instance,
- the full-access double-gate inside the escalation/runtime-mode paths, and
- agent dynamic-tool calls, attributed to the RBAC actor who started the turn
  (`checkDynamicToolPermission`), with `mutate_thread` gated per mutated field
  and `send_messaging_file` gated on `message.reply`.

A turn PwrAgent starts later on the agent's behalf (a follow-up, a Continue
After wait, a PR watch, a Claude Code review, or a Job Monitor) keeps the contact whose turn
registered it, so its tool calls are checked against that contact's role.
The contact comes from the registering turn's stored origin, never from tool
arguments. When one wake answers several requests (an identical Continue
After wait registered again, or a second watch on the same PR and head), it
takes the narrowest authority among them: two different contacts, or a
contact and the local operator, leave the wake ambiguous, and an ambiguous
wake is granted no contact's authority. A Continue After wait registered on a
peer carries the contact there, and the peer sends the contact's tool calls
back to this machine for authorization. A peer that cannot keep the contact
is refused the registration instead of running it unattributed. A Claude Code
review from messaging keeps the contact through its queue and uses a dedicated
Federation route. The review is refused when the connection or peer cannot
preserve the contact.

Render-time filtering shares the same command/action → permission lookup
tables from the shared contract, so what a user *sees* and what the
controller *enforces* cannot drift.

## Storage

Policy persists per profile under `[messaging.rbac]` in
`~/.pwragent/profiles/<name>/config.toml`
([`apps/desktop/src/main/settings/rbac-policy-store.ts`](../apps/desktop/src/main/settings/rbac-policy-store.ts)),
alongside the rest of the messaging config. Built-in roles are never
persisted — only `enforced`, custom roles, and attachments:

```toml
[messaging.rbac]
enforced = true
policy_version = 1

[[messaging.rbac.roles]]
id = "role_oncall"
name = "On-call"
permissions = ["message.reply", "thread.status.view"]

[[messaging.rbac.attachments]]
platform = "slack"
subject_kind = "actor"
actor_id = "U123"
role_ids = ["admin", "role_oncall"]
display_name = "Alice"

[[messaging.rbac.attachments]]
platform = "slack"
subject_kind = "bucket"
bucket = "channel_any_user"
scope_id = "C123"
role_ids = ["chat_user"]
```

Writes are targeted TOML edits (comments and unrelated sections preserved
byte-for-byte), which became possible when the TOML editor gained string-array
cells in table-array rows (PR #938) — earlier revisions of this feature used
an interim standalone `rbac-policy.json`, which never shipped; the store still
reads it as a fallback when no `[messaging.rbac]` section exists and retires
it (renamed `.migrated`) on the first TOML write.

**Read-failure direction is asymmetric by design.** Enforcement turns off only
when the store affirmatively knows it is off:

- *No RBAC data anywhere* (no config, or a config with no `[messaging.rbac]`
  section and no legacy JSON) → the empty, unenforced policy. The feature was
  never configured; legacy-compatible mode is correct.
- *A policy source is unreadable or contains invalid RBAC data* → **fail
  closed** with enforcement on and zero attachments. Examples include an
  I/O error, a malformed RBAC section, invalid legacy JSON, and configured
  policy with a missing or garbled `enforced` flag. Configured policy requires
  an explicit boolean `false` to disable enforcement.
  The fail-closed state is surfaced explicitly: the policy read carries a
  `failClosed` flag and the Access Control pane shows a repair callout
  (fix the file by hand; pane edits may fail while the TOML is malformed)
  instead of a puzzlingly empty enforced graph.
- Individually malformed role/attachment rows are dropped row by row, which is
  itself fail-closed: a dropped attachment grants nothing.
- A persisted role that **reuses a reserved built-in id** is discarded on read.
  Built-ins are listed before custom roles when resolving, so an impostor row
  would otherwise win the role map and silently redefine that built-in (a
  hand-edited `chat_user` granting full access, say). The genuine built-in
  still resolves; the pane names the ignored ids so the drop isn't silent.

**Policy edits take effect without a restart.** On each authorization the
service checks the backing files' device and inode, size, modification time,
and change time. A peer replacement can preserve size and modification time,
so those two fields alone would miss it. The service reuses the parsed policy
while the fingerprint stays the same. When a metadata or read operation fails,
the service checks the sources again on the next decision so transient file
errors can recover without an edit.

## Full-access guardrails

Granting `thread.execution.full_access` to a messaging actor is
near-root-equivalent control of the host. Any role granting it:

- requires the operator to type the exact acknowledgment phrase (enforced
  main-side, not just in the UI),
- carries the danger badge in the Access Control pane, and
- double-gates at enforcement time behind the global full-access toggle.

Additional workflow rules:

- Inherited Full Access launchpad defaults do not trigger dismissable warnings
  during new-thread startup.
- Explicit messaging escalation and the Always policy still require the Full
  Access warning.
- Full Access warning actions remain valid beyond the browse picker lifetime or
  report a Full Access-specific expiry.

## Audit

Audit rows land in the messaging activity log (Messaging Activity screen,
"Attention" pane), backed by the same sqlite state DB with per-origin FIFO
eviction:

- **Denials** — every capability denial records an `inbound-rejected` row with
  `reason: "unauthorized-capability"`, the permission that was missing, the
  actor's matched role IDs, and the attempted action. Bucket-admission
  rejections record the same shape with `permission: "(admission)"`.
- **Policy edits** — every Access Control mutation records a `policy` row:
  role create/update/delete (with permission lists, previous permissions, and
  danger flag), attachment set/removal (with previous role IDs), and
  enforcement toggles (with seeded-attachment counts). Edits are always the
  local desktop operator's (`payload.editedBy: "local-operator"`); rows are
  stamped `platform: "desktop"` except attachment edits, which carry the
  subject's platform. Auditing is best-effort and fail-soft — an audit write
  failure never blocks or rolls back a policy write.
- **Allow decisions are deliberately NOT audited.** Logging every permitted
  action would drown the activity log in noise (each turn involves several
  checks). Denials plus policy edits reconstruct the security-relevant story.

## Settings UI

Settings → Access Control renders the three-column authorization graph
(actors → roles → permissions) with bi-directional hover/pin tracing, bucket
subjects at distinct visual weight, a default-deny reject sink, danger glows,
inline role attach/detach, and custom-role CRUD
([`apps/desktop/src/renderer/src/features/settings/AccessControlSettings.tsx`](../apps/desktop/src/renderer/src/features/settings/AccessControlSettings.tsx)).
The renderer speaks only `@pwragent/shared` contracts over the
`messaging-rbac` IPC surface.

## Federation scope: what vs. where

Every other permission answers *what* an actor may do. `federation.remote_control`
answers *where*, and it is required **in addition to** the action's own
permission whenever the target thread lives on another instance — the same
double-gate shape as `thread.execution.full_access`, for the same reason:
`thread.resume` on a peer's thread is a materially bigger grant than on a local
one, and full access on a peer's thread is full access **on another machine**.

Why the scope needed its own axis:

- `DesktopMessagingBackendBridge.getNavigationSnapshot` merges the threads of
  every peer advertising the `messaging_route` capability into the same list as
  local threads, so a messaging actor's `/resume` picker already offers threads
  living on other instances — and the picker itself discloses peer thread
  titles before any action is taken.
- A binding carries `federatedThread`, and its operations route to the owning
  instance.
- `mutate_thread` takes `instanceId` and `includeRemote`, and `includeRemote`
  **defaults to true** — remote resolution is the default, not an opt-in.

Before the scope permission, `thread.resume` meant "resume any thread, local or
on any `messaging_route` peer". The peer's `messaging_route` opt-in is still
there and still required, but it is all-or-nothing per peer and it is the
*peer's* decision; it can't express "Alice may drive local threads but not
remote ones." That's the local operator's call, and now it's expressible.

**Where it is enforced.** Each check gates on the *resolved* target, so a
binding created while the actor had scope stops working when the scope is
removed:

| Surface | Gate |
|---|---|
| Binding to a thread | `bindChannelToThread` — the single funnel every bind path uses. Interactive entry points (callback bind, picker selection) check first so the actor gets a proper denial; the funnel itself throws as a backstop, so a caller that forgets the gate fails closed instead of binding a peer's thread |
| Status / handoff / skills callbacks | Top-guard, on the active binding |
| Plain message + media turns | The `message.reply` floor, on the active binding (silent, like the floor itself) |
| Commands (`/status`, `/schedule`, …) | Verb gate, on the active binding |
| Agent dynamic tools | Added to the required set when the args explicitly target a peer. Parent mutations also recheck before remote fallback, including when `instanceId` is omitted |

**Three exemptions, each deliberate.** `resume` and `agent` only open the
picker — it filters itself, and the bind is gated at the funnel. **`detach` is
exempt because it is a local unbind that never touches the peer**: gating it
would strand an actor whose scope was revoked mid-binding, unable to drive the
conversation and unable to leave it. Detaching is how they get unstuck.

**The picker filters, it doesn't just refuse.** The resume browser lists thread
titles and projects, so enforcement alone would still leak a peer's work to an
actor who can't touch it. `renderResumeBrowser` strips remote threads for actors
without the scope, so every row it offers is a row they may actually bind.

**Built-ins.** Only Admin holds it (it is computed from the whole catalog). Power
User, Power User + Tools, Chat User, and Limited Chat User do not — so **"local
only" is the default posture for everyone except Admin**, without duplicating the
role list into local and federated variants. A role list split that way would
also fight the additive union: hold both a local and a federated role and the
union hands you federation anyway.

**Known limit — ambient remote resolution.** `includeRemote` defaults to *true*
at the resolution layer, so a tool call that simply omits it can still resolve
onto a peer's thread. `toolArgsTargetRemoteInstance` only catches *explicit*
targeting (`instanceId`, or `includeRemote: true`), because the check is
synchronous and runs before resolution. The controller chokepoints above close
the practical path by gating on the resolved binding; fully closing the ambient
case belongs at the federation resolution site. Parent mutations now perform that
check before invoking the remote mutation handler.

## Deliberately deferred (Phase 1 boundaries)

- Adapters stamping admission-mode onto inbound events (Phase 1 infers
  named-vs-bucket from `authorizedActorIds`).
- Per-role MCP tool allowlisting.
- Issue #292's bot capability / trust boundary, and policy export/import.

## Cross-references

- [`packages/shared/src/contracts/rbac.ts`](../packages/shared/src/contracts/rbac.ts) — the executable contract this document describes
- [`docs/messaging-architecture.md`](messaging-architecture.md) — the layering RBAC plugs into (provider admission vs. controller workflow)
- [`docs/messaging-platform-integration.md`](messaging-platform-integration.md) — operator setup and the command surface being gated
