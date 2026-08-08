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
| `message.reply` | conversation | Send a plain message turn to a bound thread. The baseline floor. |
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
| `thread.settings.name` | settings | Sync the thread name to the conversation. |
| `thread.settings.skills` | settings | Open the skills browser and change enabled skills (all `skills:*` sub-actions). |
| `thread.control.stop` | control | Interrupt the running turn. |
| `thread.control.compact` | control | Compact the thread's context. |
| `thread.control.handoff` | control | Move a thread between local/worktree/branches (all `handoff:*` actions). |
| `thread.control.schedule` | control | Queue a message to the bound thread for later (`/schedule`) and list or cancel the queue (`/scheduled`). |
| `approval.respond.default` | interactive | Approve or deny non-escalation approval requests. |
| `approval.respond.escalation` | interactive (danger: med) | Approve or deny network / exec / filesystem escalation requests. |
| `tools.thread_inspection` | tools (danger: med) | Let the agent search and read OTHER threads on the actor's behalf (`search_threads`, `read_thread`, thread status, PR inspection). |
| `tools.thread_orchestration` | tools (danger: med) | Let the agent inject messages into other threads, hand off tasks, attach directories, and attach PRs. |
| `tools.instance_management` | tools (danger: med) | Let the agent manage PwrAgent itself and inspect automations (`manage_pwragent`). |
| `thread.execution.full_access` | danger (danger: high) | Select or resume into full-access execution — near-complete control of the host. |

Notes on the danger tiers:

- The three `tools.*` permissions gate the **agent acting for the messaging
  user beyond the bound thread** — a distinct privilege from operating one's
  own thread, because it can cross-thread-disclose or escalate. `mutate_thread`
  is the exception: it is gated **per field** at parity with the status-card
  buttons (`permissionsForThreadMutation`), including the full-access danger
  gate for `executionMode: "full-access"`.
- `thread.execution.full_access` is escalation-equivalent. It **double-gates**:
  the RBAC permission is required *in addition to* the existing global
  full-access toggle, never as a bypass of it.

## Built-in roles

Built-in roles ship as code constants (never persisted) and their IDs are
reserved: `admin`, `power_user`, `power_user_tools`, `chat_user`,
`limited_chat_user`.

| Role | Permission set | Intent |
|---|---|---|
| **Admin** | The whole catalog, computed — it can never silently miss a newly added capability. | The operator's own accounts. |
| **Power User** | Everything a thread operator needs EXCEPT `approval.respond.escalation`, the `tools.*` agent surface, and full access. Enumerated explicitly so new permissions are opt-in. | A trusted colleague driving their own threads. |
| **Power User + Tools** | Power User plus the three `tools.*` permissions. | A Power User also trusted to let the agent reach beyond the bound thread. |
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

All enforcement funnels through `requirePermission` in
[`apps/desktop/src/main/messaging/core/messaging-controller.ts`](../apps/desktop/src/main/messaging/core/messaging-controller.ts):

- command dispatch (`/resume`, `/new`, `/status`, `/detach`, `/monitor`, …;
  `/help` is deliberately ungated),
- a single top-guard on every status-card / handoff / questionnaire callback,
- the approval branches, split between `approval.respond.default` and
  `approval.respond.escalation` by the pending request's kind (fail-closed:
  an approval that cannot be classified requires the escalation permission),
- the `message.reply` floor for plain turns,
- the full-access double-gate inside the escalation/runtime-mode paths, and
- agent dynamic-tool calls, attributed to the RBAC actor who started the turn
  (`checkDynamicToolPermission`), with `mutate_thread` gated per mutated field.

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
- *RBAC data exists but cannot be read* (malformed TOML whose raw text still
  contains a `[messaging.rbac]` header, an unparseable legacy JSON, or a
  section whose `enforced` flag is garbled) → **fail closed**: enforced with
  zero attachments, default-denying every actor (with denial audit rows) until
  the operator repairs the file. Only a clean `enforced = false` disables
  enforcement. Falling open here would silently re-promote every admitted
  actor to Admin — the exact regression enforcement was configured to prevent.
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

**Policy edits take effect without a restart.** The service caches the parsed
policy but fingerprints the backing files (mtime + size) on every
authorization, so an edit it did not make — a hand-edited `config.toml`, or
another app instance sharing the profile — is picked up on the next check.
Revocation that only applied after a relaunch would not be revocation.

## Full-access guardrails

Granting `thread.execution.full_access` to a messaging actor is
near-root-equivalent control of the host. Any role granting it:

- requires the operator to type the exact acknowledgment phrase (enforced
  main-side, not just in the UI),
- carries the danger badge in the Access Control pane, and
- double-gates at enforcement time behind the global full-access toggle.

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

## Known gap: the catalog has no federation scope

Every permission here answers *what* an actor may do, never *where*. Federation
made that distinction load-bearing after this catalog was written:

- `DesktopMessagingBackendBridge.getNavigationSnapshot` merges the threads of
  every peer advertising the `messaging_route` capability into the same list as
  local threads, so a messaging actor's `/resume` picker already offers threads
  living on other instances — and the picker itself discloses peer thread
  titles before any action is taken.
- A binding carries `federatedThread`, and its operations route to the owning
  instance.
- `mutate_thread` takes `instanceId` and `includeRemote`, and `includeRemote`
  **defaults to true** — remote resolution is the default, not an opt-in.

So `thread.resume` today means "resume any thread, local or on any
`messaging_route` peer", and `thread.execution.full_access` on a remote thread
is full access **on that peer's machine**. The only control is the peer's own
`messaging_route` opt-in, which is all-or-nothing per peer and is the *peer's*
decision — the local operator cannot say "Alice may drive local threads but not
remote ones."

The intended shape is one orthogonal permission (e.g. `federation.remote_control`,
danger: high) required *in addition to* the action's own permission whenever the
resolved target is remote — the same double-gate as `thread.execution.full_access`
— plus filtering remote entries out of the resume picker. That keeps the additive
union intact and makes "Local Only" the default posture for every built-in except
Admin, instead of duplicating the role list into local and federated variants.

## Deliberately deferred (Phase 1 boundaries)

- Adapters stamping admission-mode onto inbound events (Phase 1 infers
  named-vs-bucket from `authorizedActorIds`).
- Per-role MCP tool allowlisting.
- Issue #292's bot capability / trust boundary, and policy export/import.

## Cross-references

- [`packages/shared/src/contracts/rbac.ts`](../packages/shared/src/contracts/rbac.ts) — the executable contract this document describes
- [`docs/messaging-architecture.md`](messaging-architecture.md) — the layering RBAC plugs into (provider admission vs. controller workflow)
- [`docs/messaging-platform-integration.md`](messaging-platform-integration.md) — operator setup and the command surface being gated
