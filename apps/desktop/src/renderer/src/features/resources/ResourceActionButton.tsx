import type { ReactElement, ReactNode } from "react";
import type { ResourceActionGate } from "@pwragent/shared/contracts/resource-checkouts";

/**
 * A button behind an authority gate. A blocked action stays focusable with
 * `aria-disabled` and explains itself in a tooltip, so a viewer without
 * permission still learns why.
 */
export function ResourceActionButton(props: {
  gate: ResourceActionGate;
  emphasis?: "primary" | "secondary" | "danger" | "ghost";
  busy?: boolean;
  children: ReactNode;
  onClick: () => void;
  testId?: string;
}): ReactElement {
  const blocked = !props.gate.allowed;
  const unavailable = blocked || props.busy;
  const className = [
    "button",
    props.emphasis === "primary"
      ? "button--primary"
      : props.emphasis === "ghost"
        ? "button--ghost"
        : "button--secondary",
    props.emphasis === "danger" ? "resources-button--danger" : undefined,
    "resources-button",
    blocked ? "tooltip-target" : undefined,
  ].filter(Boolean).join(" ");
  return (
    <button
      aria-busy={props.busy ? true : undefined}
      aria-disabled={unavailable ? true : undefined}
      className={className}
      data-testid={props.testId}
      data-tooltip={props.gate.allowed ? undefined : props.gate.detail}
      type="button"
      onClick={() => {
        if (!unavailable) props.onClick();
      }}
    >
      {props.children}
    </button>
  );
}
