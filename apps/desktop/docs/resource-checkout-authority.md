# Resource checkout authority

[Resources](resource-checkouts-ui.md) uses the same owner service as the
`pwragent` agent tools. Agent discovery and invocation of the
`resource_checkout_*` tools are gated behind **Settings → Experimental →
Federation resources** (`[experimental] resource_checkouts_enabled = true`,
disabled by default). With the setting off, threads with outstanding checkouts
retain tools to read their receipts, release their holds, and cancel their
queued requests. The same cleanup calls work from a previously loaded catalog.
With the setting on, Codex loads the checkout tools eagerly when Codex Tool
Discovery is off. The owner derives a local operator from its main window and
an agent from its authenticated thread. Request keys are scoped
to the actor. The profile mints a Federation instance ID once if it has
none, giving operator and agent receipts a stable owner across restarts.
A retry returns the recorded result. Status combines that
receipt with the current allocation or queue position.

## Machine capacity

Profiles under one PwrAgent root open `resource-checkouts.db` beside the
shared `machine-id`. SQLite serializes acquisition, job binding, recovery
and FIFO promotion across processes. The file stores the machine ID and a
local platform fingerprint when available. A mismatch quarantines the
store. Live profile advertisements come from the existing runtime markers
and do not change durable registrations or capacity.

The built-in machine pool starts with one slot per logical CPU reported by
the OS, with a one-slot fallback. Its capacity is kept in the shared
database so different CPU readings across restarts or profiles do not
resize the pool or invalidate reservations. Units are reservations among
cooperating jobs. They neither measure live load nor set process affinity. The same
machine key and queue apply to every profile in the shared root.

Machine CPU checkouts are advisory. Request one to coordinate a substantial
workload, such as a full test suite or heavy build, or when the operator
explicitly asks for a reservation. By default, start routine Dev launches from
an installed environment, short debugger or profiler sessions, and lightweight
inspection without requesting or waiting for a checkout.

For work you reserve, use `resource_checkout_action` and set `units` to the
planned parallel worker count. Omitting `units` reserves the full machine pool.
See [local CPU checkout](../../../docs/local-cpu-checkout.md) for repository
verification budgets. Wait for the grant before launching the reserved job and
release it after the job exits. A large request at the head of the queue waits
for enough slots to clear, and later small requests wait behind it.

Codex environment setup, detached environment actions, and local automation
gates do not require, claim, or wait on machine CPU checkouts. They run
outside checkout enforcement alongside agent shells, terminals, remote CI
workers, and independent applications, so an active CPU checkout never blocks
thread startup, dev servers, or automation gates, and starting a dev server
never claims the machine pool or stops when a checkout expires.

A managed job can bind the thread's only idle grant. If it has more than
one, release the extra grants before launching so the job uses the intended
reservation and deadline.

The pre-release single-slot database upgrades in place. Existing holders and
waiters retain whole-machine reservations, their tokens and their queue
order. The first upgraded profile commits the migration once.

An expired bound job retains capacity and enters recovery. On POSIX the
executor tracks the process group after shell exit and verifies that it
is empty. On Windows the Job launcher receives the stop request, terminates
its Job and confirms its active-process count reached zero. Shutdown closes
admission and waits briefly to persist that evidence. Work without verified
cleanup remains in recovery. On platforms with a reliable boot ID, a new boot can clear
process ownership from a prior boot on the same host. An operator can
confirm that a recorded POSIX group is gone from the recovery dialog.
When multiple allocations need recovery, each has its own evidence and
controls. Cleanup and administrative release recheck the selected proof.
Administrative release includes the audit note in the action receipt.

Packaged owners admit machine jobs only through the primary root. Paths
that resolve to the same root share its store. An alternate production
root stays unresolved, so run machine work from the primary root.
Unpackaged test roots use isolated stores.

## Federation external domains

An operator can place `resource-checkout-authorities.json` at the PwrAgent
root and restart the participating profiles. The same binding belongs on the
hosting owner and each participating client. Obtain the authority's
Federation instance ID from its health response, its machine ID from the
root's `machine-id`, and peer instance IDs from the enrolled Federation.
Use one configured owner per immutable external identity. This example
declares an invented resource.

```json
{
  "version": 1,
  "allowAgentDrafts": false,
  "domains": [
    {
      "canonicalKey": "external:fixture:operator-account:retained-lab",
      "displayName": "Retained lab",
      "kindLabel": "Test machine",
      "authorityInstanceId": "pwr_example_owner",
      "authorityMachineId": "mach_00000000-0000-4000-8000-000000000001",
      "allowedInstances": ["pwr_example_member"],
      "epoch": 1,
      "revision": 1,
      "updatedAt": 1795291200000,
      "capacity": 1,
      "maxHoldMs": 2700000,
      "instructions": "Follow the operator-approved lab instructions."
    }
  ]
}
```

The designated instance opens `federation-resource-checkouts.db` and
publishes the definition. An authenticated, allowlisted peer addresses it
through the existing Federation connection. Its subject is scoped to its
own instance. Other profiles cannot use the database as a substitute
authority. A disconnection makes remote results stale and blocks new
admission through that peer. Local machine admission remains available.
Connectivity changes do not write external definitions or trigger adapters.

The operator can submit a local draft from Resources. With
`allowAgentDrafts`, a local agent can submit the same unpublished draft.
Publishing requires the explicit operator binding. An incremented
definition revision updates document metadata while preserving existing
leases. A capacity, owner or epoch change leaves the resource unresolved
until the operator accepts it in Resources (see
[Ownership unresolved](#ownership-unresolved)). The owner-core authority
depends on a transaction port so a
Cloud implementation can provide its own storage and route.

## Agent continuation and handoff

After a request returns `queued`, call `resource_checkout_wait` with the
same resource and request key and a concise `continuation`. The owner saves
one Continue After dependency for this thread and receipt. The tool returns
and the agent can end its turn. The local owner observes the persisted
receipt after restart and submits a fresh promotion through the ordinary
owner turn queue. Queue admission still honors thread ownership, project
policy, thread locks, and the existing receipt for an uncertain dispatch.
An unreachable authority does not trigger a continuation. Automatic continuation requires a hold
of at least five seconds. The owner reacts to checkout changes and checks
pending receipts every 500 ms when a signal is unavailable. The turn
queue rechecks the authority before delivering a wake. An expired or
unverified grant yields a failure notice with the work plan removed. The bounded wait and
status tools remain available for agents that stay in the current turn.

Use `resource_checkout_handoff` to delegate execution of an idle grant to an
existing thread. Specify the exact allocation, generation, and epoch. For a
remote target, specify its enrolled instance. A machine grant can delegate
to a thread on its current instance. An external grant can delegate to a
thread on its configured authority or an allowlisted instance. The
authority records the executor under the same allocation, generation,
deadline, and FIFO history. The original requester keeps release authority.
Only the named executor can bind a managed job after delegation.

The tool binds the executor before submitting work through the normal
thread messaging route. The binding is idempotent. Message delivery has
its own receipt and can fail after the binding commits. If delivery is
uncertain, inspect the target thread before resending the assignment. An
unused delegated grant can be released by the requester. A release during
execution starts drain and holds capacity until cleanup is verified.

## PwrSuiteLab provider execution

PwrSuiteLab has reusable Windows EC2 test capacity when available. Consult
its private runbook for availability and approved operation.

The checkout owner can accept an approved PwrSuiteLab control at its
composition root. The adapter uses a fixed target, workload, approval,
allowed executor identities, deadline, and spending cap. Agents can select
a current grant and a cost cap within the existing approval through
`resource_checkout_execute`. The adapter admits no arbitrary provider
commands. The owner acknowledges an admitted run after binding the job.
Track the grant through the resource catalog. Release requests drain owned
work. Recovery acknowledges the job ID before cleanup and joins a retry
to the same in-flight operation. The catalog reflects the final outcome
after the controller verifies cleanup for the exact persisted execution.

An approved control must fence operations at its execution boundary. It
registers preparation and run commands before effects, enforces an
independent cost guard for the exact allocation and deadline, and seals
the execution against later deliveries before returning cleanup evidence.
After expiry or ambiguous completion, the authority requires an exact
receipt that proves no in-flight commands or owned processes remain, old
stop guards cannot act, artifacts were collected, compute is stopped, and
the retained assets are intact. Unknown evidence keeps capacity reserved.
Raw provider selectors, access procedures, and command evidence belong in
PwrSuiteLab.

This adapter has fake-effect coverage. The shipping owner has no approved
retained EC2 control wired to it. Reservations remain advisory unless the
authority has an approved controller binding. Direct credentials, arbitrary
SSH, and independent jobs remain advisory even with a managed route.

## Ownership unresolved

An authority that can't be bound shows **Ownership unresolved**. Its
resources block every other action, and the authority refuses every other
request for them.

Checkouts are cooperative reservations, not locks. Agents and managed jobs
that follow them take turns. Nothing outside the registry is stopped, and
the worst result of a wrong resolution is overlapping work until the
affected leases end. So when the app has one sensible choice, Resources
offers it. Only this instance's operator can resolve ownership: a peer or
an agent can't. The `resolve_ownership` action is idempotent, so a retry
with the same key returns the recorded result.

Each case carries a reason and a remedy (`checkout-ownership.ts`). The
inspector shows both, and a button when the case has a resolution.

| Cause | Resolution in Resources | Otherwise |
| --- | --- | --- |
| `resource-checkouts.db` was created under another machine identity | **Adopt for this machine** takes the store under this machine's identity. Checkouts and waiters that came with the copy are dropped: they never held this machine. Another profile on this root that still shows the conflict binds the adopted store without dropping anything. | Run machine work on the machine that created the root. |
| This machine's saved record differs from the current definition, pool capacity aside | **Accept current definition** saves the current definition and keeps checkouts, the queue and the pool's saved capacity. | |
| The configured owner, epoch or capacity differs from a hosted resource's saved record | **Accept configured definition** saves the configured definition and keeps checkouts and the queue. If capacity shrank, new requests wait until holds end. | Restore the previous values in `resource-checkout-authorities.json` and restart. |
| The root has no valid `machine-id` | None | Make sure the file is readable, then restart. |
| A packaged app runs from an alternate root | None | Run machine work from the primary root. |
| The machine store can't be opened | None | Read `pwragent:resource-checkouts` in the main-process log, correct the cause, and restart. |
| A binding names this instance on another machine | None | If the profile was copied from that machine, run the authority there. Otherwise correct `authorityMachineId` on every participating instance and restart them. |
| This instance hosts a binding but has no Federation store | None | Hosting needs the platform machine identity. Read the log, correct the cause, and restart. |
| This instance hosts a binding, but `federation-resource-checkouts.db` was created on another machine | None | Host it from the machine that created the root, or bind it to another instance on every participant. Federation peers hold those checkouts, so adopting the copy would hand out capacity twice. |

The cases without a resolution have nothing for the app to choose between:
the fix is a file, a path or a restart.
