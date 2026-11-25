import {
  RESOURCE_CHECKOUTS_CONTRACT_VERSION,
  type ResourceActionGates,
  type ResourceAllocation,
  type ResourceAuthority,
  type ResourceCheckoutActionRequest,
  type ResourceCheckoutActionResult,
  type ResourceCheckoutsChangedEvent,
  type ResourceCheckoutsSnapshot,
  type ResourceDomain,
  type ResourceHolder,
  type ResourceThreadRef,
  type ResourceUsageHistory,
} from "@pwragent/shared/contracts/resource-checkouts";
import type { ResourceCheckoutsSource } from "../resource-checkouts-source";
import { requestWouldWait } from "../resource-view-model";

/**
 * Invented fixture data for the development preview and tests. Every
 * resource, host, thread and operation here is made up. The preview source
 * simulates an authority so the screen's interactions can be exercised; it
 * is never used by a production window.
 */

const MIN = 60_000;

/** Invented history as [minutes ago, held, waiting] steps, oldest first. */
function previewUsage(
  now: number,
  steps: ReadonlyArray<readonly [number, number, number]>,
  observedMinutesAgo = 45,
): ResourceUsageHistory {
  return {
    observedSince: now - observedMinutesAgo * MIN,
    points: steps.map(([minutesAgo, held, waiting]) => ({ at: now - minutesAgo * MIN, held, waiting })),
  };
}

const thread = (threadId: string, title: string, instanceLabel?: string): ResourceThreadRef => ({
  backend: "codex",
  threadId,
  title,
  ...(instanceLabel ? { instanceId: `peer-${instanceLabel}`, instanceLabel } : {}),
});

const threadHolder = (ref: ResourceThreadRef): ResourceHolder => ({ kind: "thread", thread: ref });

const THREADS = {
  windows: thread("thr-win", "Verify installer shutdown on Windows"),
  coldStart: thread("thr-cold", "Profile cold start regression"),
  index: thread("thr-index", "Rebuild search index fixtures"),
  shard: thread("thr-shard", "Shard renderer tests"),
  firmware: thread("thr-fw", "Flash firmware on bench rig", "atlas-mini"),
  ranking: thread("thr-rank", "Train ranking model nightly", "atlas-mini"),
  bisect: thread("thr-bisect", "Bisect GPU memory spike"),
  smoke: thread("thr-smoke", "Smoke test signed build", "atlas-mini"),
};

const allowAll = (...kinds: Array<keyof ResourceActionGates>): ResourceActionGates =>
  Object.fromEntries(kinds.map((kind) => [kind, { allowed: true }])) as ResourceActionGates;

export type PreviewViewerRole = "operator" | "member" | "viewer";

function gatesForRole(gates: ResourceActionGates, role: PreviewViewerRole): ResourceActionGates {
  if (role === "operator") return gates;
  const manage = new Set(["fence", "verify_cleanup", "administrative_release", "resolve_ownership"]);
  return Object.fromEntries(
    Object.entries(gates).map(([kind, gate]) => {
      const denied = role === "viewer" || manage.has(kind);
      return [
        kind,
        denied
          ? {
            allowed: false,
            reason: "not_authorized",
            detail: manage.has(kind)
              ? "Only operators with manage permission can do this."
              : "You don't have permission to use this resource.",
          }
          : gate,
      ];
    }),
  ) as ResourceActionGates;
}

function allocation(
  now: number,
  values: Omit<ResourceAllocation, "grantedAt" | "deadlineAt" | "lastKnown" | "viewerOwns"> & {
    grantedMinutesAgo: number;
    deadlineMinutes: number;
    lastKnown?: boolean;
    viewerOwns?: boolean;
  },
): ResourceAllocation {
  const { grantedMinutesAgo, deadlineMinutes, ...rest } = values;
  return {
    ...rest,
    grantedAt: now - grantedMinutesAgo * MIN,
    deadlineAt: now + deadlineMinutes * MIN,
    lastKnown: values.lastKnown ?? false,
    viewerOwns: values.viewerOwns ?? false,
  };
}

export function buildPreviewAuthorities(now: number): ResourceAuthority[] {
  return [
    { authorityId: "broker-studio", kind: "machine_broker", label: "studio-m4 broker", endpointLabel: "Local socket", epoch: 4, status: "reachable", lastSnapshotAt: now, lastSnapshotRevision: 912 },
    { authorityId: "broker-atlas", kind: "machine_broker", label: "atlas-mini broker", endpointLabel: "atlas-mini over Federation", epoch: 2, status: "reachable", lastSnapshotAt: now - MIN, lastSnapshotRevision: 377 },
    { authorityId: "coord-harbor", kind: "federation_coordinator", label: "Harbor coordinator", endpointLabel: "harbor-svc (headless)", epoch: 7, status: "reachable", lastSnapshotAt: now, lastSnapshotRevision: 5120 },
    { authorityId: "coord-quarry", kind: "federation_coordinator", label: "Quarry coordinator", endpointLabel: "quarry-svc (headless)", epoch: 3, status: "unreachable", lastSnapshotAt: now - 23 * MIN, lastSnapshotRevision: 4182 },
  ];
}

export function buildPreviewResources(now: number): ResourceDomain[] {
  const ad = (instanceLabel: string, profile: string, minutesAgo: number, extra: Partial<ResourceDomain["advertisements"][number]> = {}) => ({
    instanceId: `inst-${instanceLabel}-${profile}`,
    instanceLabel,
    profile,
    isViewer: instanceLabel === "studio-m4" && profile === "default",
    onViewerMachine: instanceLabel === "studio-m4",
    observedAt: now - minutesAgo * MIN,
    freshness: "fresh" as const,
    ...extra,
  });
  return [
    {
      resourceId: "res-compute",
      canonicalKey: "machine:7f3a:cpu",
      displayName: "studio-m4 compute",
      kindLabel: "Machine compute",
      aliases: ["studio-m4"],
      conflictDomainIds: ["cd-7f3a-cpu"],
      relatedResourceIds: ["res-quiet"],
      placement: "machine",
      visibility: "federation",
      allocationScope: "machine",
      authorityId: "broker-studio",
      condition: "busy",
      sharing: { mode: "counted", capacity: 4, inUse: 3, unitLabel: "heavy-job slots" },
      usage: previewUsage(now, [[40, 1, 0], [33, 2, 0], [29, 0, 0], [26, 2, 0], [24, 4, 0], [21, 4, 1], [19, 4, 3], [17, 3, 1], [14, 2, 0], [12, 3, 0], [6, 3, 2]]),
      enforcement: { coverage: "mixed", summary: "Enforced for PwrAgent launches", gaps: ["CI runner and IDE builds on this Mac aren't admitted. Host load is advisory."] },
      allocations: [
        allocation(now, { allocationId: "alloc-311", state: "active", holder: threadHolder(THREADS.index), taskLabel: "pnpm build:fixtures", executorLabel: "studio-m4 · default", grantedMinutesAgo: 26, deadlineMinutes: 34, renewalsUsed: 0, renewalsAllowed: 3, generation: 31, authorityEpoch: 4, units: 2 }),
        allocation(now, { allocationId: "alloc-318", state: "active", holder: threadHolder(THREADS.shard), taskLabel: "vitest shard 3/4", executorLabel: "studio-m4 · dev", grantedMinutesAgo: 12, deadlineMinutes: 12, renewalsUsed: 1, renewalsAllowed: 3, generation: 32, authorityEpoch: 4, units: 1 }),
      ],
      queue: [
        { queueEntryId: "q-bisect", position: 1, requester: threadHolder(THREADS.bisect), purpose: "Repro with full parallelism", requestedAt: now - 6 * MIN, expectedDurationMs: 40 * MIN, units: 2, eligibility: { eligible: true }, viewerOwns: false },
      ],
      readiness: [
        { checkId: "profiles", label: "Profiles joined broker", state: "ok", detail: "default and dev", observedAt: now, advisory: false },
        { checkId: "load", label: "Host load", state: "warning", detail: "Load average 9.1 on 12 cores", observedAt: now - 20_000, advisory: true },
      ],
      advertisements: [
        ad("studio-m4", "default", 0, { note: "This instance" }),
        ad("studio-m4", "dev", 0, { note: "Same machine, same broker" }),
        ad("atlas-mini", "default", 1, { note: "Federation peer" }),
      ],
      routes: [
        { routeId: "rt-local", kind: "local_process", label: "Direct launch on studio-m4", status: "available", enforcement: "enforced" },
        { routeId: "rt-ssh", kind: "ssh", label: "From atlas-mini as ci-runner", status: "available", enforcement: "enforced" },
        { routeId: "rt-handoff", kind: "thread_handoff", label: "Start a thread on studio-m4", status: "available", enforcement: "enforced" },
      ],
      instructions: { revision: 6, title: "Using studio-m4 compute", source: "pwragent", sourceLabel: "Resource notes", excerpt: "Request slots equal to the job's parallel workers. Release when the command exits; a turn ending does not release the slot.", updatedAt: now - 3 * 24 * 60 * MIN },
      policy: { useScope: "Local threads; Federation peers over SSH", manageScope: "Operator", maxHoldMs: 120 * MIN, renewalRule: "Up to 3 renewals of 30m", finalEffect: "No action required" },
      cleanup: { state: "verified", detail: "Last release verified (alloc-309).", verifiedAt: now - 11 * MIN },
      recovery: null,
      ownershipConflict: null,
      definition: { revision: 3, publication: "published", updatedAt: now - 3 * 24 * 60 * MIN },
      actions: allowAll("request"),
    },
    {
      resourceId: "res-quiet",
      canonicalKey: "machine:7f3a:cpu#exclusive",
      displayName: "studio-m4 quiet benchmark window",
      kindLabel: "Exclusive window",
      aliases: [],
      conflictDomainIds: ["cd-7f3a-cpu"],
      relatedResourceIds: ["res-compute"],
      placement: "machine",
      visibility: "machine",
      allocationScope: "machine",
      authorityId: "broker-studio",
      condition: "busy",
      conditionDetail: "Admission paused until conflicting managed jobs drain.",
      sharing: { mode: "exclusive" },
      enforcement: { coverage: "mixed", summary: "Enforced for PwrAgent launches", gaps: ["Unmanaged applications keep running. Benchmarks record host load beside results."] },
      allocations: [],
      admission: { state: "paused", detail: "Waiting for 2 managed jobs on studio-m4 compute to finish. Running work isn't stopped to make room." },
      queue: [
        { queueEntryId: "q-cold", position: 1, requester: threadHolder(THREADS.coldStart), purpose: "Cold start timing, 10 runs", requestedAt: now - 9 * MIN, expectedDurationMs: 30 * MIN, eligibility: { eligible: true }, viewerOwns: false },
      ],
      readiness: [
        { checkId: "conflicts", label: "Conflicting managed jobs", state: "warning", detail: "2 active on studio-m4 compute", observedAt: now, advisory: false },
      ],
      advertisements: [ad("studio-m4", "default", 0, { note: "This instance" }), ad("studio-m4", "dev", 0, { note: "Same machine, same broker" })],
      routes: [{ routeId: "rt-local-q", kind: "local_process", label: "Direct launch on studio-m4", status: "available", enforcement: "enforced" }],
      instructions: { revision: 2, title: "Quiet window checklist", source: "pwragent", sourceLabel: "Resource notes", excerpt: "Close the browser test harness before starting. Record load average at the start and end of each run.", updatedAt: now - 9 * 24 * 60 * MIN },
      policy: { useScope: "Threads in orbit-desktop", manageScope: "Operator", maxHoldMs: 45 * MIN, renewalRule: "No renewals", finalEffect: "Resume admission" },
      cleanup: { state: "verified", detail: "Admission resumed after the last window.", verifiedAt: now - 120 * MIN },
      recovery: null,
      ownershipConflict: null,
      definition: { revision: 1, publication: "published", updatedAt: now - 9 * 24 * 60 * MIN },
      actions: allowAll("request"),
    },
    {
      resourceId: "res-serial",
      canonicalKey: "device:atlas-mini/usb-2.3",
      displayName: "bench serial rig",
      kindLabel: "Device",
      aliases: [],
      conflictDomainIds: ["cd-atlas-usb23"],
      relatedResourceIds: [],
      placement: "machine",
      visibility: "federation",
      allocationScope: "machine",
      authorityId: "broker-atlas",
      condition: "available",
      sharing: { mode: "exclusive" },
      enforcement: { coverage: "enforced", summary: "Enforced through thread handoff", gaps: [] },
      allocations: [],
      queue: [],
      readiness: [{ checkId: "present", label: "Device present", state: "ok", detail: "Serial adapter on port B3", observedAt: now - MIN, advisory: false }],
      advertisements: [{ ...ad("atlas-mini", "default", 1, { note: "Owning machine" }) }],
      routes: [
        { routeId: "rt-handoff-a", kind: "thread_handoff", label: "Start a thread on atlas-mini", status: "available", enforcement: "enforced" },
        { routeId: "rt-ssh-a", kind: "ssh", label: "SSH from studio-m4", status: "unconfigured", enforcement: "enforced", detail: "Not configured" },
      ],
      instructions: { revision: 4, title: "Bench rig", source: "skill", sourceLabel: "Skill: bench-rig", excerpt: "Hold the rig for the whole flash-and-verify cycle. Power-cycle the board before release.", updatedAt: now - 6 * 24 * 60 * MIN },
      policy: { useScope: "Threads in tidewater-fw", manageScope: "Operator", maxHoldMs: 30 * MIN, renewalRule: "1 renewal of 15m", finalEffect: "Board powered off" },
      cleanup: { state: "verified", detail: "Board power-off confirmed.", verifiedAt: now - 40 * MIN },
      recovery: null,
      ownershipConflict: null,
      definition: { revision: 4, publication: "published", updatedAt: now - 6 * 24 * 60 * MIN },
      actions: allowAll("request"),
    },
    {
      resourceId: "res-win",
      canonicalKey: "ext:cloud/acct-0041/us-east-2/vm-0c4e",
      displayName: "win-lab-07",
      kindLabel: "Retained Windows VM",
      aliases: ["windows lab"],
      conflictDomainIds: ["cd-win-lab-07"],
      relatedResourceIds: [],
      placement: "external",
      visibility: "federation",
      allocationScope: "federation",
      authorityId: "coord-harbor",
      condition: "waiting_interactive",
      conditionDetail: "Headed tests can't start until someone signs in to an unlocked desktop on win-lab-07. The deadline is running.",
      sharing: { mode: "exclusive" },
      usage: previewUsage(now, [[9, 0, 0], [7, 1, 0], [5, 0, 0], [4, 1, 0], [3, 1, 1]], 9),
      enforcement: { coverage: "mixed", summary: "Enforced through the provider adapter", gaps: ["Direct remote-desktop sessions outside PwrAgent are advisory."] },
      allocations: [
        allocation(now, { allocationId: "alloc-77", state: "preparing", holder: threadHolder(THREADS.windows), taskLabel: "Installer shutdown suite", executorLabel: "studio-m4 · default", grantedMinutesAgo: 4, deadlineMinutes: 41, renewalsUsed: 0, renewalsAllowed: 1, generation: 77, authorityEpoch: 7 }),
      ],
      queue: [
        { queueEntryId: "q-smoke", position: 1, requester: threadHolder(THREADS.smoke), purpose: "Uninstall path check", requestedAt: now - 3 * MIN, expectedDurationMs: 20 * MIN, eligibility: { eligible: true }, viewerOwns: false },
      ],
      readiness: [
        { checkId: "running", label: "Instance running", state: "ok", detail: "Started under grant g77", observedAt: now - 2 * MIN, advisory: false },
        { checkId: "creds", label: "Credentials", state: "ok", detail: "Secret-store reference resolved", observedAt: now - 2 * MIN, advisory: false },
        { checkId: "session", label: "Interactive desktop session", state: "needs_operator", detail: "No signed-in, unlocked session", observedAt: now, advisory: false },
      ],
      advertisements: [ad("studio-m4", "default", 0, { note: "Provider route configured" }), ad("atlas-mini", "default", 1, { note: "Provider route configured" })],
      routes: [
        { routeId: "rt-provider", kind: "provider_adapter", label: "Command channel", status: "available", enforcement: "enforced" },
        { routeId: "rt-rdp", kind: "ssh", label: "Remote desktop from any peer", status: "available", enforcement: "advisory", detail: "Not enforced" },
      ],
      instructions: { revision: 9, title: "Windows lab", source: "skill", sourceLabel: "Skill: windows-lab", excerpt: "Requires a signed-in desktop for headed tests. Stop the instance at release and keep the retained disk.", updatedAt: now - 24 * 60 * MIN },
      policy: { useScope: "Threads in orbit-desktop", manageScope: "Operator", maxHoldMs: 45 * MIN, renewalRule: "1 renewal of 15m within the cost ceiling", costCeilingLabel: "$2.00 per checkout", finalEffect: "Stop compute, keep disks" },
      cleanup: { state: "verified", detail: "Previous stop verified; stop guard for g76 retired.", verifiedAt: now - 55 * MIN },
      recovery: null,
      ownershipConflict: null,
      definition: { revision: 9, publication: "published", updatedAt: now - 24 * 60 * MIN },
      actions: allowAll("request"),
    },
    {
      resourceId: "res-gpu",
      canonicalKey: "ext:cloud/acct-0041/us-west-2/vm-07b1",
      displayName: "gpu-bench-02",
      kindLabel: "GPU instance",
      aliases: [],
      conflictDomainIds: ["cd-gpu-02"],
      relatedResourceIds: [],
      placement: "external",
      visibility: "federation",
      allocationScope: "federation",
      authorityId: "coord-quarry",
      // The cached snapshot said busy; the screen shows it unreachable.
      condition: "busy",
      sharing: { mode: "exclusive" },
      enforcement: { coverage: "enforced", summary: "Enforced through the provider adapter", gaps: [] },
      allocations: [
        allocation(now, { allocationId: "alloc-12", state: "active", holder: threadHolder(THREADS.ranking), taskLabel: "Nightly training run", executorLabel: "atlas-mini · default", grantedMinutesAgo: 143, deadlineMinutes: 17, renewalsUsed: 1, renewalsAllowed: 2, generation: 12, authorityEpoch: 3, lastKnown: true }),
      ],
      queue: [],
      readiness: [{ checkId: "snapshot", label: "Coordinator snapshot", state: "failing", detail: "No snapshot for 23m", observedAt: now - 23 * MIN, advisory: false }],
      advertisements: [
        ad("atlas-mini", "default", 4, { note: "Last advertisement" }),
        ad("studio-m4", "default", 26, { note: "Advertisement expired", freshness: "expired" }),
      ],
      routes: [{ routeId: "rt-provider-g", kind: "provider_adapter", label: "Command channel", status: "unreachable", enforcement: "enforced" }],
      instructions: { revision: 3, title: "GPU bench", source: "skill", sourceLabel: "Skill: gpu-bench", excerpt: "Checkpoint every 10 minutes. Stop the instance at release.", updatedAt: now - 12 * 24 * 60 * MIN },
      policy: { useScope: "Threads in kestrel-api", manageScope: "Operator", maxHoldMs: 240 * MIN, renewalRule: "2 renewals of 30m", costCeilingLabel: "$9.00 per checkout", finalEffect: "Stop compute, keep disks" },
      cleanup: { state: "unknown", detail: "Can't verify while the coordinator is unreachable." },
      recovery: null,
      ownershipConflict: null,
      definition: { revision: 3, publication: "published", updatedAt: now - 12 * 24 * 60 * MIN },
      actions: allowAll("request"),
    },
    {
      resourceId: "res-lin",
      canonicalKey: "machine:c19d:cpu",
      displayName: "lin-ci-box",
      kindLabel: "Machine compute",
      aliases: ["lin-ci-box-clone"],
      conflictDomainIds: [],
      relatedResourceIds: [],
      placement: "machine",
      visibility: "federation",
      allocationScope: "machine",
      authorityId: null,
      condition: "ownership_unresolved",
      sharing: { mode: "counted", capacity: 2, inUse: 0, unitLabel: "heavy-job slots" },
      enforcement: { coverage: "none", summary: "Quarantined", gaps: [] },
      allocations: [],
      queue: [],
      readiness: [{ checkId: "identity", label: "Machine identity", state: "failing", detail: "Two machine IDs on one host", observedAt: now - 8 * MIN, advisory: false }],
      advertisements: [
        ad("lin-ci-box", "default", 2, { note: "machine:c19d" }),
        ad("lin-ci-box-clone", "default", 2, { note: "machine:5e02" }),
      ],
      routes: [{ routeId: "rt-ssh-l", kind: "ssh", label: "Build host SSH", status: "withheld", enforcement: "enforced", detail: "Withheld while quarantined" }],
      instructions: { revision: 1, title: "Linux build host", source: "pwragent", sourceLabel: "Resource notes", excerpt: "Shared Linux build host. Use it for container builds only.", updatedAt: now - 30 * 24 * 60 * MIN },
      policy: { useScope: "All threads", manageScope: "Operator", maxHoldMs: 60 * MIN, renewalRule: "2 renewals of 30m", finalEffect: "No action required" },
      cleanup: { state: "not_applicable", detail: "No allocations while quarantined." },
      recovery: null,
      ownershipConflict: {
        reason: "This root's checkout store was created on another machine. This looks like a cloned VM image.",
        remedy: "If this root now belongs to this machine, adopt the store. Otherwise run machine work on the machine that created it.",
        resolution: {
          kind: "adopt_store",
          label: "Adopt for this machine",
          consequence: "Checkouts and waiters copied from the other machine are dropped. They never held this machine's capacity.",
        },
      },
      definition: { revision: 1, publication: "quarantined", updatedAt: now - 8 * MIN },
      actions: allowAll("resolve_ownership"),
    },
    {
      resourceId: "res-mac",
      canonicalKey: "ext:lab/rack-2/slot-03",
      displayName: "mac-lab-03",
      kindLabel: "Retained macOS VM",
      aliases: [],
      conflictDomainIds: ["cd-mac-lab-03"],
      relatedResourceIds: [],
      placement: "external",
      visibility: "federation",
      allocationScope: "federation",
      authorityId: "coord-harbor",
      condition: "recovery_required",
      sharing: { mode: "exclusive" },
      enforcement: { coverage: "enforced", summary: "Enforced through the provider adapter", gaps: [] },
      allocations: [
        allocation(now, { allocationId: "alloc-58", state: "recovery_required", holder: threadHolder(THREADS.firmware), taskLabel: "Signed build smoke test", executorLabel: "atlas-mini · default", grantedMinutesAgo: 72, deadlineMinutes: -12, renewalsUsed: 1, renewalsAllowed: 1, generation: 58, authorityEpoch: 7 }),
      ],
      queue: [
        { queueEntryId: "q-smoke-mac", position: 1, requester: threadHolder(THREADS.smoke), purpose: "Smoke test signed build", requestedAt: now - 15 * MIN, expectedDurationMs: 30 * MIN, eligibility: { eligible: true }, viewerOwns: false },
      ],
      readiness: [{ checkId: "prior", label: "Prior workload", state: "failing", detail: "Command cmd-4471 not drained", observedAt: now - MIN, advisory: false }],
      advertisements: [ad("atlas-mini", "default", 1, { note: "Provider route configured" })],
      routes: [{ routeId: "rt-lab", kind: "provider_adapter", label: "Lab controller", status: "available", enforcement: "enforced" }],
      instructions: { revision: 5, title: "macOS lab", source: "skill", sourceLabel: "Skill: mac-lab", excerpt: "Revert to the clean snapshot at release. Verify no user session remains.", updatedAt: now - 4 * 24 * 60 * MIN },
      policy: { useScope: "Threads in orbit-desktop and tidewater-fw", manageScope: "Operator", maxHoldMs: 60 * MIN, renewalRule: "1 renewal of 30m", finalEffect: "Revert to clean snapshot" },
      cleanup: { state: "failed", detail: "Snapshot revert is blocked until cmd-4471 is drained or fenced." },
      recovery: {
        allocationId: "alloc-58",
        generation: 58,
        reason: "The lease ended 12m ago. A remote command started under g58 has no final status.",
        since: now - 12 * MIN,
        fencing: "unverified",
        evidence: ["cmd-4471: in progress, last seen 13m ago", "Stop guard for g58 still scheduled", "Executor atlas-mini · default reachable"],
      },
      ownershipConflict: null,
      definition: { revision: 5, publication: "published", updatedAt: now - 4 * 24 * 60 * MIN },
      actions: allowAll("request", "fence", "verify_cleanup", "administrative_release"),
    },
  ];
}

export function buildPreviewSnapshot(now: number, role: PreviewViewerRole = "operator", revision = 1): ResourceCheckoutsSnapshot {
  return {
    contractVersion: RESOURCE_CHECKOUTS_CONTRACT_VERSION,
    revision,
    observedAt: now,
    viewer: { instanceId: "inst-studio-m4-default", instanceLabel: "studio-m4", profile: "default", machineId: "7f3a" },
    authorities: buildPreviewAuthorities(now),
    resources: buildPreviewResources(now).map((resource) => ({
      ...resource,
      actions: gatesForRole(resource.actions, role),
    })),
    registerGate: role === "operator"
      ? { allowed: true }
      : { allowed: false, reason: "not_authorized", detail: "Only operators with manage permission can register resources." },
    agentTools: "enabled",
  };
}

const OPERATOR_HOLDER: ResourceHolder = { kind: "operator", label: "You" };

/**
 * A simulated authority over the fixture data. It answers after `latencyMs`
 * so pending states can be seen, records every change under a new revision,
 * and emits a marker event like a live source.
 */
export function createPreviewResourceCheckoutsSource(options: {
  now?: () => number;
  role?: PreviewViewerRole;
  latencyMs?: number;
} = {}): ResourceCheckoutsSource & { setRole(role: PreviewViewerRole): void } {
  const clock = options.now ?? (() => Date.now());
  const latency = options.latencyMs ?? 450;
  let role: PreviewViewerRole = options.role ?? "operator";
  const base = clock();
  let revision = 1;
  let resources = buildPreviewResources(base);
  const authorities = buildPreviewAuthorities(base);
  const listeners = new Set<(event: ResourceCheckoutsChangedEvent) => void>();
  const seen = new Map<string, ResourceCheckoutActionResult>();
  let generation = 900;

  const snapshot = (): ResourceCheckoutsSnapshot => ({
    ...buildPreviewSnapshot(clock(), role, revision),
    authorities,
    resources: resources.map((resource) => ({ ...resource, actions: gatesForRole(resource.actions, role) })),
  });
  const publish = () => {
    revision += 1;
    for (const listener of listeners) listener({ revision });
  };
  const update = (resourceId: string, change: (resource: ResourceDomain) => ResourceDomain) => {
    resources = resources.map((resource) => (resource.resourceId === resourceId ? change(resource) : resource));
  };
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, latency));

  const apply = (request: ResourceCheckoutActionRequest): ResourceCheckoutActionResult => {
    const now = clock();
    if (request.kind === "register_definition") {
      const id = `res-draft-${revision}`;
      resources = [...resources, {
        resourceId: id,
        canonicalKey: request.draft.canonicalKey,
        displayName: request.draft.displayName,
        kindLabel: request.draft.kindLabel,
        aliases: [],
        conflictDomainIds: [],
        relatedResourceIds: [],
        placement: "machine",
        visibility: "instance",
        allocationScope: request.draft.allocationScope,
        authorityId: "broker-studio",
        condition: "pending_registration",
        sharing: request.draft.sharing,
        enforcement: { coverage: "none", summary: "Not enforced until published", gaps: [] },
        allocations: [],
        queue: [],
        readiness: [{ checkId: "registry", label: "Registry confirmation", state: "warning", detail: "Waiting for the studio-m4 broker", observedAt: now, advisory: false }],
        advertisements: [{ instanceId: "inst-studio-m4-default", instanceLabel: "studio-m4", profile: "default", isViewer: true, onViewerMachine: true, observedAt: now, freshness: "fresh", note: "Draft on this instance" }],
        routes: [],
        instructions: request.draft.instructionsSource
          ? { revision: 1, title: request.draft.displayName, source: "skill", sourceLabel: request.draft.instructionsSource, excerpt: "Publishes with the definition.", updatedAt: now }
          : null,
        policy: { useScope: "Operator", manageScope: "Operator", renewalRule: "No renewals", finalEffect: "No action required" },
        cleanup: { state: "not_applicable", detail: "No allocations yet." },
        recovery: null,
        ownershipConflict: null,
        definition: { revision: 1, publication: "pending_registration", updatedAt: now },
        actions: allowAll("request"),
      }];
      return { outcome: "accepted", message: "Draft saved. Not published yet." };
    }
    if (request.kind === "delegate_execution") return { outcome: "rejected", reason: "not_authorized", message: "Use the checkout handoff tool from the owning thread." };
    const resource = resources.find((candidate) => candidate.resourceId === request.resourceId);
    if (!resource) return { outcome: "rejected", reason: "not_applicable", message: "That resource is gone." };
    const gate = gatesForRole(resource.actions, role)[request.kind];
    if (gate && !gate.allowed) return { outcome: "rejected", reason: gate.reason, message: gate.detail };
    switch (request.kind) {
      case "request": {
        // The same rule that labels the button Request checkout or Join queue.
        if (!resource.queue.length && !requestWouldWait(resource, resource.condition)) {
          generation += 1;
          const allocationId = `alloc-${generation}`;
          update(resource.resourceId, (current) => ({
            ...current,
            condition: "busy",
            sharing: current.sharing.mode === "counted" ? { ...current.sharing, inUse: current.sharing.inUse + 1 } : current.sharing,
            allocations: [...current.allocations, { allocationId, state: "granted", holder: OPERATOR_HOLDER, taskLabel: request.purpose, executorLabel: "studio-m4 · default", grantedAt: now, deadlineAt: now + request.expectedDurationMs, renewalsUsed: 0, renewalsAllowed: 1, generation, authorityEpoch: 4, lastKnown: false, viewerOwns: true }],
            actions: { ...current.actions, release: { allowed: true }, extend: { allowed: true } },
          }));
          return { outcome: "granted", allocationId, generation, revision: revision + 1 };
        }
        const queueEntryId = `q-op-${revision}`;
        const position = resource.queue.length + 1;
        update(resource.resourceId, (current) => ({
          ...current,
          queue: [...current.queue, { queueEntryId, position, requester: OPERATOR_HOLDER, purpose: request.purpose, requestedAt: now, expectedDurationMs: request.expectedDurationMs, eligibility: { eligible: true }, viewerOwns: true }],
          actions: { ...current.actions, cancel_request: { allowed: true } },
        }));
        return { outcome: "queued", queueEntryId, position, revision: revision + 1 };
      }
      case "cancel_request":
        update(resource.resourceId, (current) => ({
          ...current,
          queue: current.queue.filter((entry) => entry.queueEntryId !== request.queueEntryId).map((entry, index) => ({ ...entry, position: index + 1 })),
        }));
        return { outcome: "accepted", message: "Request cancelled." };
      case "release":
        update(resource.resourceId, (current) => {
          const allocations = current.allocations.filter((entry) => entry.allocationId !== request.allocationId);
          return {
            ...current,
            allocations,
            condition: allocations.length || current.queue.length ? "busy" : "available",
            sharing: current.sharing.mode === "counted" ? { ...current.sharing, inUse: Math.max(0, current.sharing.inUse - 1) } : current.sharing,
            cleanup: { state: "verified", detail: "Cleanup verified.", verifiedAt: now },
          };
        });
        return { outcome: "accepted", message: "Released. Cleanup verified." };
      case "extend":
        update(resource.resourceId, (current) => ({
          ...current,
          allocations: current.allocations.map((entry) => entry.allocationId === request.allocationId
            ? { ...entry, renewalsUsed: entry.renewalsUsed + 1, deadlineAt: entry.deadlineAt + 15 * MIN }
            : entry),
        }));
        return { outcome: "accepted", message: "Extended by 15m." };
      case "fence":
        update(resource.resourceId, (current) => ({
          ...current,
          recovery: current.recovery && {
            ...current.recovery,
            fencing: "verified",
            evidence: ["cmd-4471: cancelled", "Stop guard for g58 retired", "Executor atlas-mini · default acknowledged"],
          },
          cleanup: { state: "in_progress", detail: "Old workload fenced. Snapshot revert ready." },
        }));
        return { outcome: "accepted", message: "Old workload fenced." };
      case "verify_cleanup":
      case "administrative_release": {
        update(resource.resourceId, (current) => {
          const [next, ...rest] = current.queue;
          generation += 1;
          return {
            ...current,
            condition: next ? "busy" : "available",
            recovery: null,
            cleanup: { state: "verified", detail: "Snapshot revert verified.", verifiedAt: now },
            allocations: next
              ? [{ allocationId: `alloc-${generation}`, state: "granted", holder: next.requester, taskLabel: next.purpose, executorLabel: "atlas-mini · default", grantedAt: now, deadlineAt: now + (next.expectedDurationMs ?? 30 * MIN), renewalsUsed: 0, renewalsAllowed: 1, generation, authorityEpoch: 7, lastKnown: false, viewerOwns: next.viewerOwns }]
              : [],
            queue: rest.map((entry, index) => ({ ...entry, position: index + 1 })),
            actions: allowAll("request"),
          };
        });
        return {
          outcome: "accepted",
          message: request.kind === "administrative_release" ? "Administrative release recorded." : "Cleanup verified. Next waiter woken.",
        };
      }
      case "resolve_ownership": {
        update(resource.resourceId, (current) => ({
          ...current,
          authorityId: "broker-studio",
          condition: "available",
          ownershipConflict: null,
          enforcement: { coverage: "enforced", summary: "Enforced for PwrAgent launches", gaps: [] },
          readiness: [{ checkId: "identity", label: "Machine identity", state: "ok", detail: "Adopted for this machine", observedAt: now, advisory: false }],
          routes: current.routes.map((route) => ({ ...route, status: "available" })),
          definition: { ...current.definition, publication: "published", updatedAt: now },
          actions: allowAll("request"),
        }));
        return { outcome: "accepted", message: "Ownership resolved." };
      }
    }
  };

  return {
    origin: "preview",
    read: async () => snapshot(),
    subscribe(onChanged) {
      listeners.add(onChanged);
      return () => listeners.delete(onChanged);
    },
    async perform(request) {
      const replay = seen.get(request.idempotencyKey);
      if (replay) return replay;
      await wait();
      const result = apply(request);
      seen.set(request.idempotencyKey, result);
      if (result.outcome !== "rejected") publish();
      return result;
    },
    setRole(next) {
      role = next;
      publish();
    },
  };
}
