import type {
  FocusEvent,
  KeyboardEvent,
  MouseEvent,
  ReactNode,
} from "react";
import type { WorktreeSnapshotSummary } from "@pwragent/shared";
import { CopyIcon } from "../../../icons";
import { copyText, formatCopyTooltip } from "../../../lib/copy-text";

/**
 * Shared building blocks for the context-rail tab panels. These were
 * lifted verbatim from `ThreadContextPanel` when it was split into a
 * tabbed activity rail so every panel (Thread Info, Linked Projects,
 * …) renders copy-to-clipboard affordances and tooltips identically.
 *
 * The rail owns the tooltip portal + its positioning state and threads
 * `showTooltip` / `hideTooltip` down to the panels via these callback
 * shapes, so a tooltip opened inside a scrolled panel still escapes the
 * panel's overflow clip.
 */
export type ShowRailTooltip = (
  event: FocusEvent<HTMLElement> | MouseEvent<HTMLElement>,
  value: string,
  maxLength?: number,
  copyHint?: boolean,
) => void;

export type HideRailTooltip = () => void;

export function CopyValueButton(props: {
  label?: string;
  "aria-label"?: string;
  maxTooltipLength?: number;
  onBlur: () => void;
  onCopy: (
    event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
    value: string,
  ) => Promise<void>;
  onShowTooltip: ShowRailTooltip;
  value: string;
}) {
  const label = props["aria-label"] ?? props.label ?? "Copy to clipboard";

  return (
    <button
      aria-label={label}
      className="context-copy-button path-copy-target"
      type="button"
      onBlur={props.onBlur}
      onClick={(event) => {
        void props.onCopy(event, props.value);
      }}
      onFocus={(event) => props.onShowTooltip(event, props.value, props.maxTooltipLength)}
      onMouseEnter={(event) =>
        props.onShowTooltip(event, props.value, props.maxTooltipLength)
      }
      onMouseLeave={props.onBlur}
    >
      <CopyIcon size={12} aria-hidden="true" />
    </button>
  );
}

export function TooltipValue(props: {
  children: ReactNode;
  label: string;
  onBlur: () => void;
  onShowTooltip: ShowRailTooltip;
  value: string;
}) {
  return (
    <span
      aria-label={props.label}
      className="context-tooltip-value"
      tabIndex={0}
      onBlur={props.onBlur}
      onFocus={(event) => props.onShowTooltip(event, props.value, undefined, false)}
      onMouseEnter={(event) => props.onShowTooltip(event, props.value, undefined, false)}
      onMouseLeave={props.onBlur}
    >
      {props.children}
    </span>
  );
}

export async function handleCopyPath(
  event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  path: string,
): Promise<void> {
  event.preventDefault();
  event.stopPropagation();
  await copyText(path);
}

export function formatTooltipValue(value: string, maxLength = 72): string {
  return elideMiddle(value, maxLength);
}

export function elideMiddle(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const visible = Math.max(8, maxLength - 1);
  const left = Math.ceil(visible / 2);
  const right = Math.floor(visible / 2);
  return `${text.slice(0, left)}…${text.slice(-right)}`;
}

export function buildRailTooltipText(
  value: string,
  maxLength: number | undefined,
  copyHint: boolean,
): string {
  return copyHint
    ? formatCopyTooltip(value, maxLength)
    : formatTooltipValue(value, maxLength);
}

export function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

export function formatAgentInstructionSummary(lineCount: number): string {
  if (lineCount <= 0) {
    return "No Agent instructions";
  }
  return `${lineCount} instruction line${lineCount === 1 ? "" : "s"}`;
}

export function findSnapshotForWorktree(
  snapshots: WorktreeSnapshotSummary[] | undefined,
  worktreePath: string,
): WorktreeSnapshotSummary | undefined {
  return snapshots?.find((snapshot) => snapshot.worktreePath === worktreePath);
}

export function pathBaseName(pathname: string): string {
  const normalized = pathname.replace(/[\\/]+$/, "");
  const segments = normalized.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? pathname;
}
