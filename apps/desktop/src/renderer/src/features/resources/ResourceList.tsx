import type { ReactElement } from "react";
import { ChevronRightIcon } from "../../icons";
import { ResourceConditionChip } from "./ResourceConditionChip";
import {
  conditionChipLabel,
  DEADLINE_SOON_MS,
  formatAge,
  formatDeadline,
  holderLabel,
  type PresentedResource,
} from "./resource-view-model";

const ROUTE_KIND_LABEL = {
  local_process: "Local process",
  ssh: "SSH",
  provider_adapter: "Provider adapter",
  thread_handoff: "Thread handoff",
} as const;

const ROUTE_STATUS_LABEL = {
  available: "Ready",
  unconfigured: "Not configured",
  unreachable: "Unreachable",
  withheld: "Withheld",
} as const;

export type ResourceListGroup = {
  key: "machine" | "federation";
  label: string;
  detail: string;
  items: PresentedResource[];
};

/**
 * One row per canonical capacity domain. A row expands in place to the
 * profiles that advertise it and the routes work can take to it; selecting
 * it opens the inspector.
 */
export function ResourceList(props: {
  groups: ResourceListGroup[];
  selectedId: string | undefined;
  expandedIds: ReadonlySet<string>;
  now: number;
  onSelect: (resourceId: string) => void;
  onToggle: (resourceId: string) => void;
}): ReactElement {
  const total = props.groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <div className="resources-list">
      <div aria-hidden="true" className="resources-list__head">
        <span />
        <span>Resource</span>
        <span>State</span>
        <span>Holder</span>
        <span>Deadline</span>
        <span>Queue</span>
      </div>
      {total === 0 ? (
        <p className="resources-list__empty">No resources match this view.</p>
      ) : null}
      {props.groups.map((group) => group.items.length === 0 ? null : (
        <section key={group.key} aria-labelledby={`resources-group-${group.key}`} className="resources-group">
          <h3 className="resources-group__label" id={`resources-group-${group.key}`}>
            {group.label}
            <span className="resources-group__detail">{group.detail}</span>
          </h3>
          <ul className="resources-group__rows">
            {group.items.map((item) => (
              <ResourceRow
                key={item.resource.resourceId}
                expanded={props.expandedIds.has(item.resource.resourceId)}
                item={item}
                now={props.now}
                selected={props.selectedId === item.resource.resourceId}
                onSelect={props.onSelect}
                onToggle={props.onToggle}
              />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function ResourceRow(props: {
  item: PresentedResource;
  selected: boolean;
  expanded: boolean;
  now: number;
  onSelect: (resourceId: string) => void;
  onToggle: (resourceId: string) => void;
}): ReactElement {
  const { resource, condition } = props.item;
  const id = resource.resourceId;
  const detailId = `resources-row-detail-${id}`;
  const holder = resource.allocations[0];
  const extraHolders = resource.allocations.length - 1;
  const chipLabel = conditionChipLabel(resource, condition);
  const deadlineSoon = holder ? holder.deadlineAt - props.now < DEADLINE_SOON_MS : false;
  return (
    <li className={`resources-row${props.selected ? " is-selected" : ""}`} data-resource-id={id}>
      <div className="resources-row__line">
        <button
          aria-controls={props.expanded ? detailId : undefined}
          aria-expanded={props.expanded}
          aria-label={`${props.expanded ? "Hide" : "Show"} routes for ${resource.displayName}`}
          className="resources-row__toggle"
          type="button"
          onClick={() => props.onToggle(id)}
        >
          <ChevronRightIcon aria-hidden size={12} />
        </button>
        <button
          aria-current={props.selected ? "true" : undefined}
          className="resources-row__select"
          type="button"
          onClick={() => props.onSelect(id)}
        >
          <span className="resources-row__name">
            <span className="resources-row__title">{resource.displayName}</span>
            <span className="resources-row__meta">
              {resource.kindLabel}
              {" · "}
              <span className="resources-mono">{resource.canonicalKey}</span>
            </span>
          </span>
          <span className="resources-row__state">
            <ResourceConditionChip condition={condition} label={chipLabel} />
          </span>
          <span className="resources-row__holder">
            {holder ? (
              <>
                <span className="resources-row__holder-title">{holderLabel(holder.holder)}</span>
                <span className="resources-row__meta">
                  {holder.taskLabel}
                  {extraHolders > 0 ? ` · +${extraHolders} more` : ""}
                  {holder.lastKnown ? " · last known" : ""}
                </span>
              </>
            ) : resource.admission?.state === "paused" ? (
              <>
                <span className="resources-row__holder-title">Admission paused</span>
                <span className="resources-row__meta">Waiting for managed jobs to finish</span>
              </>
            ) : (
              <span className="resources-row__muted">No holder</span>
            )}
          </span>
          <span className={`resources-row__deadline resources-mono${deadlineSoon ? " is-soon" : ""}`}>
            {holder ? formatDeadline(holder.deadlineAt, props.now) : <span className="resources-row__muted">—</span>}
          </span>
          <span
            className={`resources-row__queue resources-mono${resource.queue.length ? "" : " is-zero"}`}
            aria-label={`${resource.queue.length} waiting`}
          >
            <svg aria-hidden="true" focusable="false" height="11" viewBox="0 0 12 12" width="11">
              <path d="M2 3h8M2 6h8M2 9h5" stroke="currentColor" strokeWidth="1.5" />
            </svg>
            {resource.queue.length}
          </span>
        </button>
      </div>
      {props.expanded ? (
        <div className="resources-row__detail" id={detailId}>
          <div>
            <h4 className="resources-kicker">Advertised by</h4>
            <ul className="resources-facts">
              {resource.advertisements.map((ad) => (
                <li key={ad.instanceId}>
                  <span aria-hidden="true" className={`resources-dot resources-dot--${ad.freshness === "fresh" ? "ok" : "off"}`} />
                  <span className="resources-facts__what">
                    <span>{ad.instanceLabel} · {ad.profile}</span>
                    {ad.note ? <span className="resources-row__meta">{ad.note}</span> : null}
                  </span>
                  <span className="resources-facts__tag resources-mono">
                    {ad.freshness === "expired" ? "expired " : "seen "}
                    {formatAge(ad.observedAt, props.now)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="resources-kicker">Execution routes</h4>
            {resource.routes.length === 0 ? (
              <p className="resources-row__muted">No routes until the definition is published.</p>
            ) : (
              <ul className="resources-facts">
                {resource.routes.map((route) => (
                  <li key={route.routeId}>
                    <span aria-hidden="true" className={`resources-dot resources-dot--${route.status === "available" ? "ok" : route.status === "unreachable" ? "warn" : "off"}`} />
                    <span className="resources-facts__what">
                      <span>{ROUTE_KIND_LABEL[route.kind]}</span>
                      <span className="resources-row__meta">{route.label}</span>
                    </span>
                    <span className="resources-facts__tag">
                      {ROUTE_STATUS_LABEL[route.status]}
                      {route.enforcement === "advisory" ? " · advisory" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {resource.enforcement.gaps.map((gap) => (
            <p key={gap} className="resources-row__coverage">
              <span className="resources-kicker">Coverage</span> {gap}
            </p>
          ))}
        </div>
      ) : null}
    </li>
  );
}
