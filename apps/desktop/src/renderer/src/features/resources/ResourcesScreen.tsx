import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type {
  ResourceCheckoutActionRequest,
  ResourceCheckoutActionResult,
  ResourceCheckoutsSnapshot,
  ResourceThreadRef,
} from "@pwragent/shared/contracts/resource-checkouts";
import { BrandLockup } from "../chrome/BrandLockup";
import { SearchIcon } from "../../icons";
import { newResourceActionIdempotencyKey, type ResourceCheckoutsSource } from "./resource-checkouts-source";
import { useResourceCheckouts, type SettledResourceAction } from "./useResourceCheckouts";
import { ResourceList, type ResourceListGroup } from "./ResourceList";
import { ResourceInspector, type ResourceInspectorIntent } from "./ResourceInspector";
import { StatusDot } from "./ResourceConditionChip";
import {
  RecoveryDialog,
  RegisterResourceDialog,
  ReleaseDialog,
  ResolveOwnershipDialog,
  RequestCheckoutDialog,
} from "./ResourceDialogs";
import {
  formatAge,
  matchesFilter,
  matchesSearch,
  presentResources,
  resourceGroup,
  resourceRecoveries,
  resourceRecoveryGates,
  type PresentedResource,
  type ResourceActionDescriptor,
  type ResourceFilter,
  type ResourceScopeFilter,
} from "./resource-view-model";
import "./resources.css";

const FILTERS: ReadonlyArray<{ value: ResourceFilter; label: string }> = [
  { value: "all", label: "All resources" },
  { value: "held", label: "Checked out" },
  { value: "queued", label: "With a queue" },
  { value: "attention", label: "Needs attention" },
];

const SCOPES: ReadonlyArray<{ value: ResourceScopeFilter; label: string }> = [
  { value: "all", label: "Everywhere" },
  { value: "machine", label: "This machine" },
  { value: "federation", label: "Federation" },
];

type DialogState =
  | { kind: "request"; resourceId: string; action: ResourceActionDescriptor }
  | { kind: "release"; resourceId: string }
  | { kind: "recover"; resourceId: string; allocationId: string; generation: number }
  | { kind: "resolve"; resourceId: string }
  | { kind: "register" };

function groupOf(item: PresentedResource): "machine" | "federation" {
  return resourceGroup(item.resource, item.authority);
}

/**
 * One idempotency key per direct (dialog-less) action target, kept until the
 * authority gives a definite answer. Clicking again after an unknown outcome
 * resends the same key, so the authority cannot apply it twice.
 */
function useDirectActionKeys() {
  const keys = useRef(new Map<string, string>());
  return {
    keyFor(target: string): string {
      const existing = keys.current.get(target);
      if (existing) return existing;
      const created = newResourceActionIdempotencyKey();
      keys.current.set(target, created);
      return created;
    },
    settle(target: string, result: ResourceCheckoutActionResult): void {
      if (result.outcome !== "unknown") keys.current.delete(target);
    },
  };
}

/** Re-render on a slow tick so deadlines and ages stay current. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/**
 * A request to show one resource. `nonce` changes on every request, so asking
 * for the same resource again re-selects it after the operator moved away.
 */
export type ResourceFocusRequest = { resourceId: string; nonce: number };

/**
 * The Resources screen: one row per capacity domain, an inspector for the
 * selected one, and the operator's checkout actions. It reads and acts only
 * through `source`; see apps/desktop/docs/resource-checkouts-ui.md.
 */
export function ResourcesScreen(props: {
  source: ResourceCheckoutsSource;
  onOpenThread: (thread: ResourceThreadRef) => void;
  /** Omitted where the screen is its own window (the preview). */
  onClose?: () => void;
  hasWindowTitleBar?: boolean;
  /** Extra controls for the preview banner. */
  previewControls?: ReactNode;
  /** Select this resource, clearing filters that would hide it. */
  focus?: ResourceFocusRequest;
}): ReactElement {
  const { view, pending, settled, perform, refresh, dismissSettled } = useResourceCheckouts(props.source);
  const now = useNow(30_000);
  const [filter, setFilter] = useState<ResourceFilter>("all");
  const [scope, setScope] = useState<ResourceScopeFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const focus = props.focus;
  // A focus request selects its resource once it is in a snapshot, and only
  // once, so the operator can move away from it afterwards.
  const [appliedFocus, setAppliedFocus] = useState<ResourceFocusRequest>();
  const listPaneRef = useRef<HTMLDivElement>(null);

  const snapshot = view.status === "loading" ? undefined : view.snapshot;
  const presented = useMemo(() => (snapshot ? presentResources(snapshot) : []), [snapshot]);
  const directKeys = useDirectActionKeys();
  const counts = useMemo(() => {
    const scoped = presented.filter((item) => scope === "all" || groupOf(item) === scope);
    return Object.fromEntries(FILTERS.map(({ value }) => [value, scoped.filter((item) => matchesFilter(item, value)).length])) as Record<ResourceFilter, number>;
  }, [presented, scope]);
  const visible = useMemo(
    () => presented.filter((item) =>
      (scope === "all" || groupOf(item) === scope)
      && matchesFilter(item, filter)
      && matchesSearch(item.resource, query)),
    [filter, presented, query, scope],
  );
  const groups: ResourceListGroup[] = [
    {
      key: "machine",
      label: "This machine",
      detail: snapshot ? `All profiles on ${snapshot.viewer.instanceLabel} share this pool` : "",
      items: visible.filter((item) => groupOf(item) === "machine"),
    },
    {
      key: "federation",
      label: "Federation",
      detail: "Allocated by a coordinator or a peer's broker",
      items: visible.filter((item) => groupOf(item) === "federation"),
    },
  ];
  const ordered = groups.flatMap((group) => group.items);
  // Compared by value: a parent may pass an equal request as a new object.
  const focusPending = Boolean(focus
    && (focus.nonce !== appliedFocus?.nonce || focus.resourceId !== appliedFocus.resourceId)
    && presented.some((item) => item.resource.resourceId === focus.resourceId));
  useEffect(() => {
    if (!focus || !focusPending) return;
    setAppliedFocus(focus);
    setFilter("all");
    setScope("all");
    setQuery("");
    setSelectedId(focus.resourceId);
  }, [focus, focusPending]);
  useEffect(() => {
    if (!appliedFocus) return;
    const row = [...listPaneRef.current?.querySelectorAll<HTMLElement>("[data-resource-id]") ?? []]
      .find((element) => element.dataset.resourceId === appliedFocus.resourceId);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [appliedFocus]);
  // Only a visible row can be inspected: once a filter, scope or search hides
  // the selection, the inspector follows the first row still shown.
  const selected = ordered.find((item) => item.resource.resourceId === selectedId)
    ?? ordered[0];

  // Dialogs show their own failures, so only success reaches the screen.
  const submit = useCallback(
    (request: ResourceCheckoutActionRequest): Promise<ResourceCheckoutActionResult> =>
      perform(request, { reportFailure: false }),
    [perform],
  );

  const performDirect = (target: string, build: (idempotencyKey: string) => ResourceCheckoutActionRequest) => {
    void perform(build(directKeys.keyFor(target))).then((result) => directKeys.settle(target, result));
  };

  const onIntent = (intent: ResourceInspectorIntent) => {
    if (!selected) return;
    const resource = selected.resource;
    if (intent.kind === "recover") return setDialog({ ...intent, resourceId: resource.resourceId });
    const { action } = intent;
    switch (action.kind) {
      case "request":
        return setDialog({ kind: "request", resourceId: resource.resourceId, action });
      case "release":
        return setDialog({ kind: "release", resourceId: resource.resourceId });
      case "resolve_ownership":
        return setDialog({ kind: "resolve", resourceId: resource.resourceId });
      case "cancel_request": {
        const entry = resource.queue.find((candidate) => candidate.viewerOwns);
        if (entry) {
          performDirect(`cancel_request:${entry.queueEntryId}`, (idempotencyKey) => ({ kind: "cancel_request", idempotencyKey, resourceId: resource.resourceId, queueEntryId: entry.queueEntryId }));
        }
        return;
      }
      case "extend": {
        const held = resource.allocations.find((candidate) => candidate.viewerOwns);
        if (held) {
          performDirect(`extend:${held.allocationId}:${held.generation}`, (idempotencyKey) => ({ kind: "extend", idempotencyKey, resourceId: resource.resourceId, allocationId: held.allocationId, generation: held.generation }));
        }
        return;
      }
      default:
        return;
    }
  };

  const dialogResource = dialog && dialog.kind !== "register"
    ? presented.find((item) => item.resource.resourceId === dialog.resourceId)
    : undefined;
  const dialogRecovery = dialog?.kind === "recover" && dialogResource
    ? resourceRecoveries(dialogResource.resource).find((entry) => entry.allocationId === dialog.allocationId && entry.generation === dialog.generation)
    : undefined;
  const dialogOpen = dialog?.kind === "register" || Boolean(dialogResource);
  const closeDialog = () => setDialog(null);
  const filterLabel = FILTERS.find((entry) => entry.value === filter)?.label ?? "All resources";
  const registerGate = snapshot?.registerGate;

  return (
    <section aria-label="Resources" className="resources-screen">
      <nav aria-label="Resource navigation" className="settings-nav" inert={dialogOpen}>
        {!props.hasWindowTitleBar ? (
          <header className="settings-nav__masthead">
            <BrandLockup variant="settings-nav" />
          </header>
        ) : null}
        {props.onClose ? (
          <button className="settings-nav__exit" type="button" onClick={props.onClose}>
            <span aria-hidden="true">←</span> Exit Resources
          </button>
        ) : null}
        <button
          aria-disabled={registerGate?.allowed ? undefined : true}
          className={`settings-nav__new resources-nav__register${registerGate && !registerGate.allowed ? " tooltip-target is-blocked" : ""}`}
          data-tooltip={registerGate && !registerGate.allowed ? registerGate.detail : undefined}
          type="button"
          onClick={() => {
            if (registerGate?.allowed) setDialog({ kind: "register" });
          }}
        >
          <span aria-hidden="true" className="settings-nav__new-plus">+</span>{" "}
          Register Resource
        </button>
        <p className="settings-nav__group-label">Show</p>
        {FILTERS.map((entry) => (
          <button
            key={entry.value}
            aria-current={filter === entry.value ? "page" : undefined}
            className={`settings-nav__button resources-nav__button${filter === entry.value ? " is-active" : ""}`}
            type="button"
            onClick={() => setFilter(entry.value)}
          >
            <span>{entry.label}</span>
            <span className={`resources-nav__count${counts[entry.value] ? "" : " is-zero"}`}>{snapshot ? counts[entry.value] : ""}</span>
          </button>
        ))}
        <p className="settings-nav__group-label">Where</p>
        {SCOPES.map((entry) => (
          <button
            key={entry.value}
            aria-pressed={scope === entry.value}
            className={`settings-nav__button${scope === entry.value ? " is-active" : ""}`}
            type="button"
            onClick={() => setScope(entry.value)}
          >
            {entry.label}
          </button>
        ))}
      </nav>

      <div className="resources-main" inert={dialogOpen}>
        <header className="settings-titlebar">
          <div className="settings-titlebar__breadcrumb">
            <span className="settings-titlebar__eyebrow">Resources</span>
            <span aria-hidden="true" className="settings-titlebar__separator">›</span>
            <span className="settings-titlebar__current">{filterLabel}</span>
          </div>
          <div className="settings-titlebar__spacer" />
          {snapshot ? <AuthorityStrip now={now} snapshot={snapshot} /> : null}
        </header>

        {props.source.origin === "preview" ? (
          <div className="resources-preview-banner" data-testid="resources-preview-banner" role="note">
            <span className="resources-preview-banner__label">Preview data</span>
            <span>Every resource here is invented and actions are simulated. Nothing is checked out.</span>
            {props.previewControls ? <span className="resources-preview-banner__controls">{props.previewControls}</span> : null}
          </div>
        ) : null}

        {view.status === "error" ? (
          <div className="resources-error" role="alert">
            <span>
              {view.snapshot
                ? `Couldn't refresh. Showing revision ${view.snapshot.revision}, which may be out of date.`
                : "Couldn't read resource checkouts."}
              {" "}
              {view.message}
            </span>
            <button className="button button--secondary resources-button" type="button" onClick={() => void refresh()}>Try again</button>
          </div>
        ) : null}

        {snapshot ? (
          <div className="resources-body">
            <div ref={listPaneRef} className="resources-list-pane">
              <div className="resources-toolbar">
                <h2>Resources</h2>
                <label className="resources-search">
                  <SearchIcon aria-hidden size={13} />
                  <input
                    aria-label="Filter by name, kind or identity"
                    placeholder="Filter by name or identity"
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                  />
                </label>
              </div>
              <ResourceList
                expandedIds={expandedIds}
                groups={groups}
                now={now}
                selectedId={selected?.resource.resourceId}
                onSelect={setSelectedId}
                onToggle={(id) => setExpandedIds((current) => {
                  const next = new Set(current);
                  if (next.has(id)) next.delete(id);
                  else next.add(id);
                  return next;
                })}
              />
            </div>
            <ResourceInspector
              busyKind={pending.find(({ request }) => "resourceId" in request && request.resourceId === selected?.resource.resourceId)?.request.kind}
              item={selected}
              now={now}
              onIntent={onIntent}
              onOpenThread={props.onOpenThread}
              {...(snapshot ? { localInstanceId: snapshot.viewer.instanceId } : {})}
            />
          </div>
        ) : view.status === "loading" ? (
          <p aria-busy="true" className="resources-loading">Reading resources…</p>
        ) : null}

        {settled ? <SettledNotice settled={settled} onDismiss={dismissSettled} /> : null}
      </div>

      {dialog?.kind === "register" ? (
        <RegisterResourceDialog submit={submit} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "request" && dialogResource ? (
        <RequestCheckoutDialog action={dialog.action} now={now} resource={dialogResource.resource} submit={submit} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "release" && dialogResource ? (
        <ReleaseDialog resource={dialogResource.resource} submit={submit} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "recover" && dialogResource ? (
        <RecoveryDialog
          recovery={dialogRecovery}
          actions={dialogRecovery ? resourceRecoveryGates(dialogResource.resource, dialogResource.authority, dialogRecovery) : {}}
          resource={dialogResource.resource}
          submit={submit}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "resolve" && dialogResource ? (
        <ResolveOwnershipDialog resource={dialogResource.resource} submit={submit} onClose={closeDialog} />
      ) : null}
    </section>
  );
}

function AuthorityStrip(props: { snapshot: ResourceCheckoutsSnapshot; now: number }): ReactElement {
  return (
    <ul aria-label="Checkout authorities" className="resources-authorities">
      {props.snapshot.authorities.map((authority) => (
        <li key={authority.authorityId}>
          <StatusDot tone={authority.status === "reachable" ? "ok" : "off"} />
          <span>{authority.label}</span>
          <span className="resources-mono resources-authorities__meta">
            {authority.status === "reachable"
              ? `epoch ${authority.epoch}`
              : authority.status === "unreachable"
                ? `unreachable${authority.lastSnapshotAt ? ` · ${formatAge(authority.lastSnapshotAt, props.now)}` : ""}`
                : "unresolved"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function settledText(settled: SettledResourceAction): string {
  const { result } = settled;
  switch (result.outcome) {
    case "granted":
      return "Granted.";
    case "queued":
      return `Queued at #${result.position}.`;
    case "accepted":
      return result.message ?? "Done.";
    case "rejected":
      return result.message;
    case "unknown":
      return `The authority didn't confirm this. ${result.message}`;
  }
}

function SettledNotice(props: { settled: SettledResourceAction; onDismiss: () => void }): ReactElement {
  const failed = props.settled.result.outcome === "rejected" || props.settled.result.outcome === "unknown";
  return (
    <div className={`resources-notice${failed ? " is-problem" : ""}`} role="status">
      <span>{settledText(props.settled)}</span>
      <button aria-label="Dismiss" className="resources-notice__dismiss" type="button" onClick={props.onDismiss}>×</button>
    </div>
  );
}
