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

The machine starts with one exclusive slot. Detached Codex environment
actions claim the slot before spawning, including when an action is invoked
on its owning instance through Federation. An action can consume a grant
held by its thread. Without a matching grant, the action tries to claim
idle capacity and reports contention in the existing action error UI.
Manual holds and agent requests can join the durable queue. Other launch
paths, including agent shells, terminals, CI and independent applications,
are advisory.

An expired bound job retains capacity and enters recovery. On POSIX the
executor verifies that the process group is empty. On Windows the Job
launcher confirms its active-process count reached zero. If the Windows
launcher is killed before recording that evidence, the checkout stays in
recovery. On platforms with a reliable boot ID, a new boot can clear
process ownership from a prior boot on the same host. An operator can
confirm that a recorded POSIX group is gone from the recovery dialog.
Cleanup and administrative release recheck the proof. Administrative
release includes the audit note in the action receipt.

Alternate roots are independent. They require separate operator enrollment
decisions and should not be treated as additional physical capacity. Moving
or restoring a store, VM clones, and authority migration require an
operator-controlled drain and reconciliation.

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

External reservations are advisory. The provider executor port binds an
exact job and grant before preparation, requires an explicit executor
policy and budget, and requires proof of fencing and the configured final
state before release. Fake adapters verify this contract. No shipping
PwrSuiteLab adapter runs provider operations through it yet. Continue using
the existing PwrSuiteLab access, spending and lifecycle policies.

Agent tools support discovery, checkout actions, receipt/status lookups,
and a bounded wait for FIFO promotion. Promotion persists even when no
agent or renderer is watching. A thread can re-read the result from a later
turn. Automatic dispatch of a new agent turn after promotion and grant
transfer to a handoff target are outside the current implementation.
