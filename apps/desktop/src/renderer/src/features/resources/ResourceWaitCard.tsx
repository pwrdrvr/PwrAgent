import { useEffect, useState, type ReactElement } from "react";
import type { ResourceCheckoutsSnapshot } from "@pwragent/shared/contracts/resource-checkouts";
import type { ThreadDependencyCondition } from "@pwragent/shared/contracts/thread-dependencies";
import { formatDeadline, formatDuration } from "./resource-view-model";
import {
  describeQueueEntryHold,
  describeResourceWaitPlace,
  summarizeResourceWait,
  type ResourceWaiter,
} from "./resource-wait";
import "./resource-wait-card.css";

/** The main window gets no change events for checkouts, so it re-reads. */
const RESOURCE_WAIT_REFRESH_MS = 15_000;

export type ResourceCheckoutsRead = () => Promise<ResourceCheckoutsSnapshot>;

export type ResourceSnapshotState =
  | { status: "idle" | "loading" }
  | { status: "ready"; snapshot: ResourceCheckoutsSnapshot }
  | { status: "error" };

/**
 * This profile's checkout snapshot while `enabled`, re-read on a slow tick.
 * A failed re-read keeps the last snapshot rather than blanking the card.
 */
export function useResourceCheckoutsSnapshot(read: ResourceCheckoutsRead | undefined, enabled: boolean): ResourceSnapshotState {
  const [state, setState] = useState<ResourceSnapshotState>({ status: "idle" });
  const active = Boolean(read) && enabled;
  useEffect(() => {
    if (!active || !read) return;
    let cancelled = false;
    const load = (): void => {
      read().then(
        (snapshot) => { if (!cancelled) setState({ status: "ready", snapshot }); },
        () => { if (!cancelled) setState((current) => current.status === "ready" ? current : { status: "error" }); },
      );
    };
    setState((current) => current.status === "ready" ? current : { status: "loading" });
    load();
    const timer = window.setInterval(load, RESOURCE_WAIT_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active, read]);
  return active ? state : { status: "idle" };
}

/** A resource checkout condition's resource id, when the condition is one. */
export function resourceWaitId(condition: Pick<ThreadDependencyCondition, "resourceCheckout">): string | undefined {
  return condition.resourceCheckout?.resourceId;
}

/** "a machine compute checkout", from the resource's kind when it is known. */
export function resourceWaitNoun(snapshot: ResourceCheckoutsSnapshot | undefined, resourceId: string): string {
  const kind = snapshot?.resources.find((resource) => resource.resourceId === resourceId)?.kindLabel.trim();
  if (!kind) return "a resource checkout";
  // "Machine compute" reads "machine compute"; "VM pool" keeps its acronym.
  const noun = /^[A-Z][a-z]/.test(kind) ? kind.charAt(0).toLowerCase() + kind.slice(1) : kind;
  return `${/^[aeiou]/i.test(noun) ? "an" : "a"} ${noun} checkout`;
}

/**
 * One resource wait: the resource, the thread's place in its queue and why it
 * has not started, who holds it and for how long, and how much of its use
 * PwrAgent enforces. Shared by the Waiting for tab and Continue After.
 */
export function ResourceWaitCard(props: {
  resourceId: string;
  waiter: ResourceWaiter;
  state: ResourceSnapshotState;
  now: number;
  /** Opens Resources on this resource; absent where no Resources window opens. */
  onOpenResource?: (resourceId: string) => void;
}): ReactElement {
  const snapshot = props.state.status === "ready" ? props.state.snapshot : undefined;
  const summary = snapshot ? summarizeResourceWait(snapshot, props.resourceId, props.waiter) : undefined;
  const open = props.onOpenResource ? (
    <button
      type="button"
      className="resource-wait-card__open"
      data-testid="resource-wait-open"
      onClick={() => props.onOpenResource!(props.resourceId)}
    >
      Open in Resources…
    </button>
  ) : null;

  if (!summary) {
    return (
      <div className="resource-wait-card" data-testid="resource-wait-card">
        <p className="resource-wait-card__note">
          {props.state.status === "loading" ? "Reading the queue…"
            : props.state.status === "ready" ? "This window's resource list does not include this resource."
            : props.state.status === "error" ? "Couldn't read the resource queue."
            : "The resource queue is on the thread's owner."}
        </p>
        {open}
      </div>
    );
  }

  const { place } = summary;
  return (
    <div className="resource-wait-card" data-testid="resource-wait-card">
      <div className="resource-wait-card__head">
        <span className="resource-wait-card__name">{summary.name}</span>
        <span className="resource-wait-card__kind">{summary.kindLabel}</span>
        <span className="resource-wait-card__condition">{summary.conditionLabel}</span>
      </div>
      <dl className="resource-wait-card__facts">
        <dt>Place</dt>
        <dd>
          {describeResourceWaitPlace(place)}
          {place.kind === "queued" ? (
            <span className={`resource-wait-card__sub${place.hold.reason === "order" && place.hold.fitsNow ? " is-warning" : ""}`}>
              {describeQueueEntryHold(place.hold, place.position, summary.unit)}
            </span>
          ) : null}
          {place.kind === "queued" && place.holds !== undefined ? (
            <span className="resource-wait-card__sub is-warning" data-testid="resource-wait-also-holds">
              {`This thread already holds ${place.holds} ${summary.unit}${place.holds === 1 ? "" : "s"}. They stay reserved while it waits.`}
            </span>
          ) : null}
        </dd>
        <dt>Held by</dt>
        <dd>
          {summary.holders.length === 0 ? "Nobody else" : summary.holders.map((holder, index) => (
            <span className="resource-wait-card__holder" key={index}>
              {holder.label}
              {holder.units !== undefined ? ` · ${holder.units} ${summary.unit}${holder.units === 1 ? "" : "s"}` : ""}
              <span className="resource-wait-card__sub">
                {`Held ${formatDuration(Math.max(0, props.now - holder.grantedAt))} of ${formatDuration(Math.max(0, holder.deadlineAt - holder.grantedAt))} expected · ${formatDeadline(holder.deadlineAt, props.now)}`}
              </span>
            </span>
          ))}
        </dd>
        {summary.capacity ? (
          <>
            <dt>Capacity</dt>
            <dd>{summary.capacity}</dd>
          </>
        ) : null}
        <dt>Shared by</dt>
        <dd>{summary.scopeLabel}</dd>
        <dt>Enforced</dt>
        <dd>
          {summary.enforcement.label}
          {/* What is outside enforcement is what the operator needs to know. */}
          <span className="resource-wait-card__sub">{summary.enforcement.gaps[0] ?? summary.enforcement.summary}</span>
        </dd>
      </dl>
      {open}
    </div>
  );
}
