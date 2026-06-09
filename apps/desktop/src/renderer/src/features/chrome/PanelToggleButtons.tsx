import { useEffect, type ReactElement } from "react";
import { isEditableTarget, isPrimaryAccel } from "../../lib/keyboard-accel";

/**
 * Window layout chips — show/hide the left sidebar (primary) and the
 * right context rail (secondary). The glyph is asymmetric: the primary
 * chip carves a strip on the LEFT of a rounded rect, the secondary on
 * the RIGHT, so the divider position alone tells them apart even before
 * the fill state reads. When the panel is open the strip fills with the
 * accent color; when closed only the outline remains. Same idea Apple /
 * VS Code use for their side-bar chips.
 *
 * Presentational: the parent owns the open/hidden state + persistence;
 * these buttons paint the state and dispatch callbacks.
 *
 * Keyboard: ⌘B / ⌃B toggles the sidebar, ⌘⌥B / ⌃⌥B toggles the rail.
 */
export type PanelToggleButtonsProps = {
  /** Whether the left sidebar is currently shown. */
  sidebarOpen: boolean;
  /** Whether the right context rail is currently pinned open. */
  railOpen: boolean;
  onToggleSidebar: () => void;
  onToggleRail: () => void;
  className?: string;
  /** Skip the window-level keydown listener (when a parent owns chords). */
  disableHotkeys?: boolean;
};

export function PanelToggleButtons({
  sidebarOpen,
  railOpen,
  onToggleSidebar,
  onToggleRail,
  className,
  disableHotkeys = false,
}: PanelToggleButtonsProps): ReactElement {
  useEffect(() => {
    if (disableHotkeys) {
      return;
    }
    const handler = (event: KeyboardEvent): void => {
      if (isEditableTarget(event)) {
        return;
      }
      if (!isPrimaryAccel(event)) {
        return;
      }
      if (event.key !== "b" && event.key !== "B") {
        return;
      }
      event.preventDefault();
      if (event.altKey) {
        onToggleRail();
      } else {
        onToggleSidebar();
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [disableHotkeys, onToggleSidebar, onToggleRail]);

  return (
    <div
      className={`panel-toggle${className ? ` ${className}` : ""}`}
      role="group"
      aria-label="Window layout"
    >
      <LayoutChip kind="primary" open={sidebarOpen} onClick={onToggleSidebar} />
      <LayoutChip kind="secondary" open={railOpen} onClick={onToggleRail} />
    </div>
  );
}

function LayoutChip({
  kind,
  open,
  onClick,
}: {
  kind: "primary" | "secondary";
  open: boolean;
  onClick: () => void;
}): ReactElement {
  const label =
    kind === "primary"
      ? open
        ? "Hide sidebar"
        : "Show sidebar"
      : open
        ? "Hide context rail"
        : "Show context rail";
  const chord = kind === "primary" ? "⌘B" : "⌘⌥B";
  return (
    <button
      type="button"
      className={`panel-toggle__chip is-${kind} ${open ? "is-open" : "is-closed"}`}
      aria-label={label}
      aria-pressed={open}
      title={`${label}  (${chord})`}
      onClick={onClick}
    >
      <LayoutGlyph kind={kind} open={open} />
    </button>
  );
}

function LayoutGlyph({
  kind,
  open,
}: {
  kind: "primary" | "secondary";
  open: boolean;
}): ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" />
      {kind === "primary" ? (
        <>
          <path d="M8 4v16" />
          {open ? (
            <rect x="3" y="4" width="5" height="16" rx="1.5" fill="currentColor" stroke="none" />
          ) : null}
        </>
      ) : (
        <>
          <path d="M16 4v16" />
          {open ? (
            <rect x="16" y="4" width="5" height="16" rx="1.5" fill="currentColor" stroke="none" />
          ) : null}
        </>
      )}
    </svg>
  );
}
