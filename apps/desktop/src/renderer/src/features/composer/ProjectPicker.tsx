import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../lib/navigation-loaded-rows";
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FolderIcon, SearchIcon } from "../../icons";
import { tildifyPath } from "../../lib/tildify-path";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { useTodoFactMenuPlacement } from "../thread-todos/TodoFactMenu";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "./native-picker-boundary";

/**
 * Project-directory picker for the new-thread composer (issue #223).
 *
 * Behavior:
 *   - The button reads "No selected project" (dashed border) when no
 *     directory is selected, or shows the current directory's label
 *     otherwise.
 *   - Opening the popover lists tracked directories (workspace + plain
 *     directory entries) sorted by `latestUpdatedAt` desc, capped at 10.
 *     A search input filters by label or path.
 *   - The "+ Add directory…" action at the bottom triggers the system
 *     "Choose folder" dialog via the desktop bridge. Validation lives in
 *     the main process — the picker just surfaces the inline error
 *     string when registration fails (e.g. "not a git repo").
 *
 * The picker is presentation-only; the parent is responsible for
 * wiring `onSelect` (existing directory) and `onPickFromDisk`
 * (system dialog → register flow). Errors come back through the
 * `pickError` prop so we don't keep transient async state inside this
 * component — that lives in the parent's hook.
 */
export type ProjectPickerProps = {
  /** Currently-selected directory, if any. */
  value?: NavigationDirectorySummary;
  /** All tracked directories from the navigation snapshot. */
  directories: NavigationDirectorySummary[];
  /** Optional owner-side search for a bounded directory page. */
  onQueryChange?: (query: string) => void;
  /** Disabled while a thread is being materialized, etc. */
  disabled?: boolean;
  /** Inline error string from the most-recent register attempt. */
  pickError?: string;
  /** Whether the system dialog is currently open / register in flight. */
  picking?: boolean;
  onSelect: (directory: NavigationDirectorySummary) => void;
  onPickFromDisk?: () => void;
  nativePickingDisabled?: boolean;
  /**
   * Switch the launchpad to a directory-less ("workspace") thread. When
   * omitted, the "Chat without a directory" row is not rendered.
   */
  onSelectNoDirectory?: () => void;
  /**
   * Replaces the composer's project pill with the caller's own control, such
   * as the context rail's "Attach folder" row. The popover is unchanged.
   */
  trigger?: { className: string; ariaLabel: string; content: ReactNode };
  /**
   * Draws the popover on `document.body`, placed against the trigger, for a
   * host that clips or is narrower than the 440px panel (the context rail).
   */
  portal?: boolean;
  onOpenChange?: (open: boolean) => void;
};

const RECENTS_LIMIT = 10;
const POPOVER_WIDTH = 440;

function formatLabel(directory: NavigationDirectorySummary): string {
  return directory.label || (directory.path ? tildifyPath(directory.path) : directory.key);
}

function formatPath(directory: NavigationDirectorySummary): string {
  return directory.path ? tildifyPath(directory.path) : "—";
}

function isPickable(directory: NavigationDirectorySummary): boolean {
  // The "unlinked" pseudo-directory and our internal scratch
  // workspace-collector entry are not pickable from the project picker
  // — they don't correspond to a folder the user picked.
  return directory.kind !== "unlinked";
}

export function ProjectPicker(props: ProjectPickerProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const containerRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const errorId = useId();
  const portal = props.portal === true;
  const getPortaledSurface = useCallback(() => popRef.current, []);
  // A layer, not a document listener: inside a dialog, the dialog would
  // otherwise take the Escape meant for this popover and close with it.
  useDismissableLayer({
    open,
    onDismiss: () => setOpen(false),
    surfaceRef: containerRef,
    triggerRef,
    ...(portal ? { getPortaledSurface } : {}),
  });
  const placement = useTodoFactMenuPlacement({
    open: open && portal,
    triggerRef,
    menuRef: popRef,
    width: POPOVER_WIDTH,
  });
  const onOpenChange = props.onOpenChange;
  // Balanced, like the rail's other portaled menus: true while open, false
  // on close or unmount, and nothing for a picker that never opened.
  useEffect(() => {
    if (!open) return undefined;
    onOpenChange?.(true);
    return () => onOpenChange?.(false);
  }, [onOpenChange, open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !popRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const sorted = useMemo(() => {
    const pickable = props.directories.filter(isPickable);
    const ordered = [...pickable].sort(
      (left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0),
    );
    const top = ordered.slice(0, RECENTS_LIMIT);
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) {
      return top;
    }
    return top.filter((directory) => {
      const label = formatLabel(directory).toLowerCase();
      const path = (directory.path ?? "").toLowerCase();
      return label.includes(trimmed) || path.includes(trimmed);
    });
  }, [props.directories, query]);

  const buttonLabel = props.value ? formatLabel(props.value) : "No selected project";
  const isEmpty = !props.value;

  return (
    <span
      ref={containerRef}
      className="project-picker"
      data-state={open ? "open" : "closed"}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        // When the most-recent register attempt failed, point screen
        // readers at the inline error so it's announced when focus
        // returns to the trigger. `aria-describedby` is wider-supported
        // than `aria-errormessage`, and the message is short enough to
        // read fluently as a description.
        aria-describedby={props.pickError ? errorId : undefined}
        aria-label={
          props.trigger?.ariaLabel
            ?? (props.value ? `Project: ${buttonLabel}` : "Choose a project")
        }
        className={props.trigger?.className ?? `project-picker__trigger${
          isEmpty ? " is-empty" : " is-active"
        }`}
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {props.trigger ? props.trigger.content : (
          <>
            <FolderIcon size={13} />
            <span className="project-picker__label">{buttonLabel}</span>
          </>
        )}
      </button>

      {open ? renderPopover(
        <div
          ref={popRef}
          className={`project-picker__pop${portal ? " project-picker__pop--portal" : ""}`}
          role="dialog"
          aria-label="Project picker"
          style={portal ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight } : undefined}
        >
          <div className="project-picker__search">
            <span aria-hidden="true" className="project-picker__search-icon">
              <SearchIcon size={13} />
            </span>
            <input
              type="text"
              autoFocus
              placeholder="Find a directory"
              className="project-picker__search-input"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                props.onQueryChange?.(event.target.value);
              }}
            />
          </div>

          {props.onSelectNoDirectory ? (
            <button
              type="button"
              aria-pressed={isEmpty}
              className={`project-picker__row project-picker__row--no-directory${
                isEmpty ? " is-active" : ""
              }`}
              onClick={() => {
                setOpen(false);
                props.onSelectNoDirectory?.();
              }}
            >
              <span aria-hidden="true" className="project-picker__row-check">
                {isEmpty ? "✓" : ""}
              </span>
              <span className="project-picker__no-directory-icon" aria-hidden="true">
                <FolderIcon size={13} />
                <span className="project-picker__no-directory-slash" />
              </span>
              <span className="project-picker__no-directory-text">
                Chat without a directory
              </span>
            </button>
          ) : null}

          <div className="project-picker__section">Recent directories</div>
          <ul
            className="project-picker__list"
            id={listboxId}
            role="listbox"
            aria-label="Tracked directories"
          >
            {sorted.length === 0 ? (
              <li className="project-picker__empty">
                {query ? "No matches." : "No tracked directories yet."}
              </li>
            ) : (
              sorted.map((directory) => {
                const active =
                  props.value && props.value.key === directory.key;
                return (
                  <li key={directory.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={Boolean(active)}
                      className={`project-picker__row${
                        active ? " is-active" : ""
                      }`}
                      onClick={() => {
                        setOpen(false);
                        props.onSelect(directory);
                      }}
                    >
                      <span aria-hidden="true" className="project-picker__row-check">
                        {active ? "✓" : ""}
                      </span>
                      <span aria-hidden="true" className="project-picker__row-icon">
                        <FolderIcon size={13} />
                      </span>
                      <span className="project-picker__row-name">
                        {formatLabel(directory)}
                      </span>
                      <span className="project-picker__row-path">
                        {formatPath(directory)}
                      </span>
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {props.onPickFromDisk ? (
            <>
              <div className="project-picker__separator" />

              <button
                type="button"
                className="project-picker__row project-picker__row--action"
                data-tooltip={
                  props.nativePickingDisabled
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
                disabled={props.picking || props.nativePickingDisabled}
                title={
                  props.nativePickingDisabled
                    ? REMOTE_NATIVE_PICKER_TOOLTIP
                    : undefined
                }
                onClick={() => {
                  setOpen(false);
                  props.onPickFromDisk?.();
                }}
              >
                <span aria-hidden="true" className="project-picker__row-check" />
                <span aria-hidden="true" className="project-picker__plus">
                  +
                </span>
                <span className="project-picker__row-name">
                  {props.picking ? "Picking…" : "Add directory…"}
                </span>
              </button>
            </>
          ) : null}

          {props.pickError ? (
            <p
              id={errorId}
              role="alert"
              className="project-picker__error"
            >
              {props.pickError}
            </p>
          ) : null}
        </div>,
      ) : null}
    </span>
  );

  function renderPopover(popover: ReactElement): ReactNode {
    return portal ? createPortal(popover, document.body) : popover;
  }
}
