# Resource checkout authority

[Resources](resource-checkouts-ui.md) uses the same owner service as the
`pwragent` agent tools. The owner derives a local operator from its main
window and an agent from its authenticated thread. Request keys are scoped
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

The machine starts with one exclusive slot. Codex environment setup,
environment actions, and local automation gates claim the slot before
launch. Startup, explicit reruns, workspace restore and owner-routed
Federation environment actions use the same admission path. A finite setup
can use its thread's existing grant and returns it to `granted` after verified
cleanup. An environment action consumes the grant. A launch with an unknown
thread or an automation gate can use idle capacity. An operator hold or
earlier waiter blocks those launches. Agent shells, terminals, remote CI
workers, and independent applications are advisory.

An expired bound job retains capacity and enters recovery. On POSIX the
executor tracks the process group after shell exit and verifies that it
is empty. On Windows the Job launcher receives the stop request, terminates
its Job and confirms its active-process count reached zero. Shutdown closes
admission and waits briefly to persist that evidence. Work without verified
cleanup remains in recovery. On platforms with a reliable boot ID, a new boot can clear
process ownership from a prior boot on the same host. An operator can
confirm that a recorded POSIX group is gone from the recovery dialog.
Cleanup and administrative release recheck the proof. Administrative
release includes the audit note in the action receipt.

Roots still open independent stores. A production root outside the primary
root needs shared-broker enrollment before it can publish or consume
enforced physical capacity. See the recovery procedure below.

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
leases. A capacity, owner or epoch change requires a separate migration
procedure. The owner-core authority depends on a transaction port so a
Cloud implementation can provide its own storage and route.

## Agent continuation and handoff

After a request returns `queued`, call `resource_checkout_wait` with the
same resource and request key and a concise `continuation`. The owner saves
one Continue After dependency for this thread and receipt. The tool returns
and the agent can end its turn. The local owner observes the persisted
receipt after restart and submits a fresh promotion through the ordinary
owner turn queue. Queue admission still honors thread ownership, project
policy, thread locks, and the existing receipt for an uncertain dispatch.
An unreachable authority does not trigger a continuation. If a checkout
ends before admission, the continuation receives a failure notice. A queued
wake rechecks the grant before it uses the resource. The bounded wait and
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
work. Recovery retries only cleanup for the exact persisted execution.

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

## Fenced enrollment, restore, and migration procedure

The recovery policy in `resource-checkout-recovery.ts` is exercised offline.
It requires a durable registry witness outside the source and destination
authority backups. The shipped manifest does not provide that witness.
Treat conflicting manifests, restored production stores, and unenrolled
production roots as unresolved pending reconciliation.

1. **Enroll the host.** A production root enrolls with the authenticated
   OS broker under the canonical physical host domain. Pin its broker,
   its platform evidence, and the root's enrollment identity. Another
   profile or installed root joins that same broker and store. Test roots
   remain isolated. A copied root, alternate OS account, managed VM parent,
   or host clone needs explicit enrollment evidence. Missing evidence
   leaves it unresolved and unpublished.
2. **Quarantine the canonical domain.** Gather each conflicting authority
   and store incarnation for the immutable resource key. Compare-and-swap
   the live witness revision to `fencing` before staging a successor. Every
   allocator and executor must consult that witness at the admission and
   effect boundary. Close the legacy launch or credential paths that
   cannot enforce the witness. A partition leaves the domain closed.
3. **Drain and prove fences.** Record fresh, revision-scoped evidence for
   every incumbent or competing issuer. Capture closed admission, drained
   jobs, sealed delayed commands, retired stop guards, and the highest
   generation issued. Include the provider or process evidence required
   by the domain. An unknown issuer or missing proof pauses migration. Discovering another
   issuer advances the fencing revision and invalidates earlier proofs and
   checkpoints.
4. **Stage the successor disabled.** Choose a new store incarnation even
   when restoring to the same owner. Allocate an epoch above all confirmed
   issuers and seed its counter at the highest witnessed generation. Import
   definitions, receipts, and historical records for audit. Old grants,
   waiters, and continuations are non-executable. Have requesters submit
   fresh intents after cutover. Record the staged checkpoint and verify it
   against the fenced domain and destination.
5. **Activate by compare-and-swap.** Publish the exact staged checkpoint
   against the fencing revision. Reject stale owners and backups by the
   issuer tuple, epoch, and current witness checkpoint. A registry must
   advance the checkpoint with durable admission state, including changes
   that reuse the current generation. If staging or activation fails,
   keep the domain closed and retry against the same fencing revision.
   Returning to an earlier owner requires a new fenced cutover.
