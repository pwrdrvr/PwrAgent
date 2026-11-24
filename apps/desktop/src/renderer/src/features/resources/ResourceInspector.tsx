import type { ReactElement, ReactNode } from "react";
import type {
  ResourceAllocation,
  ResourceAllocationState,
  ResourceHolder,
  ResourceQueueEntry,
  ResourceReadinessState,
  ResourceRecoveryStatus,
  ResourceThreadRef,
} from "@pwragent/shared/contracts/resource-checkouts";
import { ConditionGlyph, ResourceConditionChip, StatusDot, type StatusDotTone } from "./ResourceConditionChip";
import { ResourceActionButton } from "./ResourceActionButton";
import {
  capacitySummary,
  conditionChipLabel,
  DEADLINE_SOON_MS,
  formatAge,
  formatDeadline,
  formatDuration,
  freeUnits,
  holderLabel,
  presentCondition,
  resourceActions,
  resourceRecoveries,
  resourceRecoveryGates,
  type PresentedResource,
  type ResourceActionDescriptor,
} from "./resource-view-model";
import { allocationHoldTime, describeQueueEntryHold, holderAlsoQueued, queueEntryHold } from "./resource-wait";

/** The header controls group recovery steps behind one Recover control. */
export type ResourceInspectorIntent =
  | { kind: "action"; action: ResourceActionDescriptor }
  | { kind: "recover"; allocationId: string; generation: number };

const LIFECYCLE: ReadonlyArray<ResourceAllocationState | "queued" | "released"> = [
  "queued",
  "granted",
  "preparing",
  "active",
  "draining",
  "released",
];

const READINESS_DOT: Record<ResourceReadinessState, StatusDotTone> = {
  ok: "ok",
  warning: "warn",
  failing: "err",
  needs_operator: "warn",
  unknown: "off",
};

const AUTHORITY_KIND_LABEL = {
  machine_broker: "Machine broker",
  federation_coordinator: "Federation coordinator",
  cloud_coordinator: "Cloud coordinator",
} as const;

export function ResourceInspector(props: {
  item: PresentedResource | undefined;
  now: number;
  busyKind: string | undefined;
  onIntent: (intent: ResourceInspectorIntent) => void;
  onOpenThread: (thread: ResourceThreadRef) => void;
}): ReactElement {
  const item = props.item;
  if (!item) {
    return (
      <aside aria-label="Resource detail" className="resources-inspector resources-inspector--empty">
        <p>Select a resource to see its holder, queue and instructions.</p>
      </aside>
    );
  }
  const { resource, authority, condition } = item;
  const actions = resourceActions(resource, authority);
  const recoveryActions = actions.filter((action) =>
    action.kind === "fence" || action.kind === "verify_cleanup" || action.kind === "administrative_release");
  const resolveAction = actions.find((action) => action.kind === "resolve_ownership");
  const headerActions = actions.filter((action) => !recoveryActions.includes(action) && action !== resolveAction);
  const recoveries = resourceRecoveries(resource);
  const recoverButton = (recovery: ResourceRecoveryStatus, label: string, testId?: string) => {
    const gates = Object.values(resourceRecoveryGates(resource, authority, recovery));
    const gate = gates.find((candidate) => candidate?.allowed) ?? gates.find(Boolean);
    return gate ? (
      <ResourceActionButton
        emphasis="danger"
        gate={gate}
        testId={testId}
        onClick={() => props.onIntent({ kind: "recover", allocationId: recovery.allocationId, generation: recovery.generation })}
      >
        {label}
      </ResourceActionButton>
    ) : null;
  };
  const counted = capacitySummary(resource);
  const unitLabel = resource.placement === "machine" ? "CPU slot" : "unit";
  const firstRequest = resource.queue[0]?.units;
  const free = freeUnits(resource);
  const waitingForSlots = condition === "busy" && firstRequest !== undefined && free !== undefined && firstRequest > free;

  return (
    <aside aria-labelledby="resources-inspector-title" className="resources-inspector">
      <header className="resources-inspector__head">
        <div className="resources-inspector__title-row">
          <div className="resources-inspector__title">
            <h3 id="resources-inspector-title">{resource.displayName}</h3>
            <span className="resources-mono resources-inspector__key">{resource.canonicalKey}</span>
          </div>
          <ResourceConditionChip condition={condition} label={conditionChipLabel(resource, condition)} />
        </div>
        <div className="resources-inspector__actions">
          {headerActions.map((action) => (
            <ResourceActionButton
              key={action.kind}
              busy={props.busyKind === action.kind}
              emphasis={action.emphasis}
              gate={action.gate}
              testId={`resources-action-${action.kind}`}
              onClick={() => props.onIntent({ kind: "action", action })}
            >
              {action.label}
            </ResourceActionButton>
          ))}
        </div>
      </header>

      <div aria-label="Checkout details" className="resources-inspector__body" role="region" tabIndex={0}>
        <StateCallout
          item={item}
          now={props.now}
          recover={recoveries.length === 1 ? recoverButton(recoveries[0], "Recover…", "resources-action-recover") : null}
          resolve={resolveAction ? (
            <ResourceActionButton
              busy={props.busyKind === resolveAction.kind}
              emphasis={resolveAction.emphasis}
              gate={resolveAction.gate}
              testId="resources-action-resolve"
              onClick={() => props.onIntent({ kind: "action", action: resolveAction })}
            >
              {`${resolveAction.label}…`}
            </ResourceActionButton>
          ) : null}
        />

        <Section title="Holder" aside={counted ?? (resource.sharing.mode === "exclusive" ? "Exclusive" : undefined)}>
          {resource.allocations.length === 0 ? (
            <p className="resources-note">
              {resource.admission?.state === "paused" ? "Granted next when conflicting jobs finish." : "Not checked out."}
            </p>
          ) : (
            resource.allocations.map((allocation) => (
              <AllocationDetail
                key={allocation.allocationId}
                allocation={allocation}
                alsoQueued={holderAlsoQueued(resource, allocation.holder)}
                unitLabel={unitLabel}
                now={props.now}
                onOpenThread={props.onOpenThread}
              />
            ))
          )}
        </Section>

        <Section title="Queue" aside="FIFO with backfill">
          {waitingForSlots ? (
            <p className="resources-note">
              The first request needs {firstRequest} {unitLabel}s. {free} free now. Shorter requests that fit without delaying #1 can backfill.
            </p>
          ) : null}
          {resource.queue.length === 0 ? (
            <p className="resources-note">Nobody is waiting.</p>
          ) : (
            <ol className="resources-queue">
              {resource.queue.map((entry) => (
                <li key={entry.queueEntryId} className={entry.viewerOwns ? "is-mine" : undefined}>
                  <span className="resources-queue__pos resources-mono">#{entry.position}</span>
                  <span className="resources-queue__who">
                    <HolderName holder={entry.requester} onOpenThread={props.onOpenThread} />
                    <span className="resources-row__meta">
                      {entry.purpose}
                      {entry.units !== undefined ? ` · ${entry.units} ${unitLabel}${entry.units === 1 ? "" : "s"} requested` : ""}
                      {entry.expectedDurationMs ? ` · ${formatDuration(entry.expectedDurationMs)}` : ""}
                      {` · waiting ${formatAge(entry.requestedAt, props.now)}`}
                      {entry.eligibility.eligible ? "" : ` · ${entry.eligibility.reason}`}
                    </span>
                    {(() => {
                      const hold = queueEntryHold(resource, entry);
                      return (
                        <span className="resources-row__meta resources-queue__hold" data-testid="resources-queue-hold">
                          {describeQueueEntryHold(hold, entry.position, unitLabel)}
                          {hold.reason === "order" && hold.fitsNow ? <span className="resources-flag">Fits now</span> : null}
                        </span>
                      );
                    })()}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section title="Readiness">
          <ul className="resources-facts">
            {resource.readiness.map((check) => (
              <li key={check.checkId}>
                <StatusDot tone={READINESS_DOT[check.state]} />
                <span className="resources-facts__what">
                  <span>
                    {check.label}
                    {check.state === "needs_operator" ? <span className="resources-flag">Needs you</span> : null}
                  </span>
                  <span className="resources-row__meta">
                    {check.detail}
                    {check.advisory ? " · advisory" : ""}
                  </span>
                </span>
                <span className="resources-facts__tag resources-mono">
                  {check.observedAt === undefined ? "" : formatAge(check.observedAt, props.now)}
                </span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Instructions" aside={resource.instructions ? `rev ${resource.instructions.revision}` : undefined}>
          {resource.instructions ? (
            <>
              <p className="resources-instructions">{resource.instructions.excerpt}</p>
              <p className="resources-note">
                {resource.instructions.sourceLabel}. Instructions can't change permissions, limits or ownership.
              </p>
            </>
          ) : (
            <p className="resources-note">No instructions attached.</p>
          )}
        </Section>

        <Section title="Authority" aside={authority ? `epoch ${authority.epoch}` : undefined}>
          {authority ? (
            <dl className="resources-pairs">
              <dt>Allocator</dt>
              <dd>{authority.label}</dd>
              <dt>Kind</dt>
              <dd>{AUTHORITY_KIND_LABEL[authority.kind]}</dd>
              <dt>Endpoint</dt>
              <dd className="resources-mono">{authority.endpointLabel}</dd>
              <dt>Status</dt>
              <dd>
                {authority.status === "reachable"
                  ? "Reachable"
                  : authority.status === "unreachable"
                    ? `Unreachable${authority.lastSnapshotAt ? ` · last snapshot ${formatAge(authority.lastSnapshotAt, props.now)} ago` : ""}`
                    : "Unresolved"}
              </dd>
              <dt>Scope</dt>
              <dd>{scopeLabel(resource.allocationScope)} allocation · {resource.placement === "external" ? "external capacity" : "machine-bound"}</dd>
            </dl>
          ) : (
            <p className="resources-note">No authority is bound while ownership is unresolved.</p>
          )}
        </Section>

        <Section title="Cleanup and recovery">
          <dl className="resources-pairs">
            <dt>At release</dt>
            <dd>{resource.policy.finalEffect}</dd>
            <dt>Last cleanup</dt>
            <dd>{resource.cleanup.detail}</dd>
          </dl>
          {recoveries.map((recovery) => {
            const label = resource.allocations.find(({ allocationId }) => allocationId === recovery.allocationId)?.taskLabel
              ?? `Grant ${recovery.generation}`;
            return (
              <div className="resources-allocation" key={recovery.allocationId}>
                <dl className="resources-pairs">
                  <dt>Task</dt><dd>{label}</dd>
                  <dt>Fencing</dt><dd>{recovery.fencing === "verified" ? "Verified" : "Not verified"}</dd>
                  <dt>Evidence</dt>
                  <dd>
                    {recovery.evidence.length ? (
                      <ul className="resources-evidence">
                        {recovery.evidence.map((line) => <li key={line}>{line}</li>)}
                      </ul>
                    ) : recovery.reason}
                  </dd>
                </dl>
                {recoveries.length > 1 ? recoverButton(recovery, `Recover ${label}`) : null}
              </div>
            );
          })}
        </Section>

        <Section title="Policy">
          <dl className="resources-pairs">
            <dt>Who can use</dt>
            <dd>{resource.policy.useScope}</dd>
            <dt>Who can manage</dt>
            <dd>{resource.policy.manageScope}</dd>
            <dt>Max hold</dt>
            <dd>
              {resource.policy.maxHoldMs ? formatDuration(resource.policy.maxHoldMs) : "No limit"}
              {` · ${resource.policy.renewalRule}`}
            </dd>
            <dt>Cost ceiling</dt>
            <dd>{resource.policy.costCeilingLabel ?? "None"}</dd>
            <dt>Enforcement</dt>
            <dd>{resource.enforcement.summary}</dd>
          </dl>
        </Section>

        <Section title="Definition" aside={`rev ${resource.definition.revision}`}>
          <dl className="resources-pairs">
            <dt>Status</dt>
            <dd>{publicationLabel(resource.definition.publication)}</dd>
            <dt>Updated</dt>
            <dd>{formatAge(resource.definition.updatedAt, props.now)} ago</dd>
            {resource.aliases.length ? (
              <>
                <dt>Aliases</dt>
                <dd>{resource.aliases.join(", ")}</dd>
              </>
            ) : null}
          </dl>
        </Section>
      </div>
    </aside>
  );
}

function Section(props: { title: string; aside?: string; children: ReactNode }): ReactElement {
  return (
    <section className="resources-section">
      <h4 className="resources-kicker resources-section__title">
        <span>{props.title}</span>
        {props.aside ? <span className="resources-section__aside">{props.aside}</span> : null}
      </h4>
      {props.children}
    </section>
  );
}

function StateCallout(props: {
  item: PresentedResource;
  now: number;
  recover: ReactNode;
  resolve: ReactNode;
}): ReactElement | null {
  const { resource, authority, condition } = props.item;
  const presentation = presentCondition(condition);
  let title: string | undefined;
  let body: ReactNode;
  /** The operator's next step, in words. */
  let next: string | undefined;
  let action: ReactNode = null;
  let tone: "warn" | "danger" | "muted" | "plain" = "plain";
  switch (condition) {
    case "waiting_interactive":
      title = "Waiting for an interactive session";
      body = resource.conditionDetail ?? presentation.meaning;
      tone = "warn";
      break;
    case "unreachable": {
      const holder = resource.allocations[0];
      title = authority ? `${authority.label} unreachable` : "Authority unreachable";
      body = (
        <>
          {authority?.lastSnapshotAt
            ? `Showing the snapshot from ${formatAge(authority.lastSnapshotAt, props.now)} ago. `
            : "No snapshot is available. "}
          It can't grant or queue work, and no other authority takes over automatically.
          {holder ? ` The last known holder may continue until its lease ends (${formatDeadline(holder.deadlineAt, props.now)}).` : ""}
        </>
      );
      tone = "muted";
      break;
    }
    case "ownership_unresolved":
      title = "Ownership unresolved";
      body = resource.ownershipConflict?.reason ?? resource.conditionDetail ?? presentation.meaning;
      next = resource.ownershipConflict?.remedy;
      action = props.resolve;
      tone = "danger";
      break;
    case "recovery_required":
      title = "Recovery required";
      body = `${resourceRecoveries(resource).length > 1 ? "Multiple jobs need cleanup." : (resource.recovery?.reason ?? presentation.meaning)} The resource stays reserved and the next waiter isn't woken.`;
      action = props.recover;
      tone = "danger";
      break;
    case "draining":
      title = "Draining";
      body = "Owned work is stopping and cleanup is being verified. The next waiter is woken after verification.";
      break;
    case "pending_registration":
      title = "Pending registration";
      body = "Saved on this instance. Other instances can't see or request it until the registry confirms the definition.";
      tone = "muted";
      break;
    default:
      if (resource.admission?.state === "paused") {
        title = "Admission paused";
        body = resource.admission.detail;
      }
  }
  if (!title) return null;
  return (
    <div className={`resources-callout resources-callout--${tone}`} role="note">
      <ConditionGlyph tone={presentation.tone} />
      <div>
        <p className="resources-callout__title">{title}</p>
        <p className="resources-callout__body">{body}</p>
        {next ? <p className="resources-callout__body" data-testid="resources-callout-next-step">{next}</p> : null}
        {action ? <div className="resources-callout__actions">{action}</div> : null}
      </div>
    </div>
  );
}

function AllocationDetail(props: {
  allocation: ResourceAllocation;
  /** The holder's own request for more of the same resource. */
  alsoQueued?: ResourceQueueEntry;
  unitLabel: string;
  now: number;
  onOpenThread: (thread: ResourceThreadRef) => void;
}): ReactElement {
  const { allocation } = props;
  const inRecovery = allocation.state === "recovery_required";
  const at = LIFECYCLE.indexOf(allocation.state);
  const soon = allocation.deadlineAt - props.now < DEADLINE_SOON_MS;
  const { heldMs, expectedMs } = allocationHoldTime(allocation, props.now);
  return (
    <div className="resources-allocation">
      <ol aria-label={`Checkout state: ${allocation.state.replace("_", " ")}`} className="resources-lifecycle">
        {LIFECYCLE.map((step, index) => {
          const state = inRecovery
            ? index <= 3 ? "done" : "todo"
            : index < at ? "done" : index === at ? "now" : "todo";
          return (
            <li key={step} aria-current={state === "now" ? "step" : undefined} className={`is-${state}`}>
              {step}
            </li>
          );
        })}
        {inRecovery ? <li aria-current="step" className="is-alert">recovery</li> : null}
      </ol>
      <dl className="resources-pairs">
        <dt>Holder</dt>
        <dd>
          <HolderName holder={allocation.holder} onOpenThread={props.onOpenThread} />
          {allocation.lastKnown ? <span className="resources-note"> · last known</span> : null}
        </dd>
        <dt>Task</dt>
        <dd>{allocation.taskLabel}{allocation.units ? ` · ${allocation.units} ${props.unitLabel}${allocation.units === 1 ? "" : "s"} held` : ""}</dd>
        <dt>Runs on</dt>
        <dd>{allocation.executorLabel}</dd>
        <dt>Held</dt>
        <dd>
          {`${formatDuration(heldMs)} of ${formatDuration(expectedMs)} expected · granted ${formatAge(allocation.grantedAt, props.now)} ago`}
          {props.alsoQueued ? (
            <span className="resources-row__meta resources-allocation__also-queued">
              {`Also waits at #${props.alsoQueued.position} in the queue${props.alsoQueued.units !== undefined ? ` for ${props.alsoQueued.units} more` : ""}. What it holds stays reserved until it releases.`}
              <span className="resources-flag">Holding and queued</span>
            </span>
          ) : null}
        </dd>
        <dt>Deadline</dt>
        <dd className={`resources-mono${soon ? " resources-deadline-soon" : ""}`}>
          {formatDeadline(allocation.deadlineAt, props.now)} · renewals {allocation.renewalsUsed}/{allocation.renewalsAllowed}
        </dd>
        <dt>Grant</dt>
        <dd className="resources-mono">
          {allocation.allocationId} · g{allocation.generation} · epoch {allocation.authorityEpoch}
        </dd>
      </dl>
    </div>
  );
}

function HolderName(props: {
  holder: ResourceHolder;
  onOpenThread: (thread: ResourceThreadRef) => void;
}): ReactElement {
  if (props.holder.kind === "thread") {
    const thread = props.holder.thread;
    return (
      <button className="resources-link" type="button" onClick={() => props.onOpenThread(thread)}>
        {thread.title}
        {thread.instanceLabel ? <span className="resources-row__meta"> · {thread.instanceLabel}</span> : null}
      </button>
    );
  }
  return <span>{holderLabel(props.holder)}</span>;
}

function scopeLabel(scope: "instance" | "machine" | "federation"): string {
  switch (scope) {
    case "instance":
      return "Instance";
    case "machine":
      return "Machine";
    case "federation":
      return "Federation";
  }
}

function publicationLabel(publication: "published" | "pending_registration" | "quarantined"): string {
  switch (publication) {
    case "published":
      return "Published";
    case "pending_registration":
      return "Pending registration";
    case "quarantined":
      return "Quarantined";
  }
}
