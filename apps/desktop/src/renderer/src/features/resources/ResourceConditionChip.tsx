import type { ReactElement } from "react";
import type { ResourceCondition } from "@pwragent/shared/contracts/resource-checkouts";
import { presentCondition, type ResourceConditionTone } from "./resource-view-model";

export type StatusDotTone = "ok" | "warn" | "err" | "off";

const STATUS_DOT_CLASS: Record<StatusDotTone, string> = {
  ok: "status-dot status-dot--ok",
  warn: "status-dot status-dot--warning",
  err: "status-dot status-dot--error",
  // A hollow ring, so "off" differs from the others by shape as well as color.
  off: "status-dot resources-dot--off",
};

/** A small state pip using the app's `.status-dot` vocabulary. */
export function StatusDot(props: { tone: StatusDotTone }): ReactElement {
  return <span aria-hidden="true" className={STATUS_DOT_CLASS[props.tone]} />;
}

/**
 * A resource's state as glyph plus words. Each state has its own glyph shape
 * as well as its own tone, so Busy, Authority unreachable, Needs interactive
 * session and Ownership unresolved stay distinct without color.
 */
export function ResourceConditionChip(props: {
  condition: ResourceCondition;
  /** Replaces the label, e.g. "1 of 4 free" for counted capacity. */
  label?: string;
}): ReactElement {
  const presentation = presentCondition(props.condition);
  return (
    <span
      className={`resources-chip resources-chip--${presentation.tone}`}
      data-condition={props.condition}
    >
      <ConditionGlyph tone={presentation.tone} />
      <span className="resources-chip__label">{props.label ?? presentation.label}</span>
    </span>
  );
}

export function ConditionGlyph(props: { tone: ResourceConditionTone }): ReactElement {
  const common = {
    "aria-hidden": true,
    className: "resources-chip__glyph",
    focusable: false,
    height: 12,
    viewBox: "0 0 12 12",
    width: 12,
  } as const;
  switch (props.tone) {
    case "available":
      return <svg {...common}><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.75" /></svg>;
    case "busy":
      return <svg {...common}><rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" /></svg>;
    case "draining":
      return (
        <svg {...common}>
          <rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <rect x="2" y="6" width="8" height="4" rx="1" fill="currentColor" />
        </svg>
      );
    case "interactive":
      return (
        <svg {...common}>
          <rect x="1.5" y="2" width="9" height="6.5" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M4 10.5h4" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "unreachable":
      return <svg {...common}><circle cx="6" cy="6" r="4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 2" /></svg>;
    case "unresolved":
      return (
        <svg {...common}>
          <path d="M6 1.5 10.5 6 6 10.5 1.5 6Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d="M6 4.5v2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "recovery":
      return (
        <svg {...common}>
          <path d="M6 1.5 11 10H1Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
          <path d="M6 5v2.2" stroke="currentColor" strokeWidth="1.5" />
        </svg>
      );
    case "draft":
      return <svg {...common}><rect x="2" y="2" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 1.5" /></svg>;
  }
}
