import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";
import type { NavigationDirectorySummary } from "@pwragent/shared";
import { FolderIcon } from "../../icons";

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
  /** Disabled while a thread is being materialized, etc. */
  disabled?: boolean;
  /** Inline error string from the most-recent register attempt. */
  pickError?: string;
  /** Whether the system dialog is currently open / register in flight. */
  picking?: boolean;
  onSelect: (directory: NavigationDirectorySummary) => void;
  onPickFromDisk: () => void;
};

const RECENTS_LIMIT = 10;

function formatLabel(directory: NavigationDirectorySummary): string {
  return directory.label || directory.path || directory.key;
}

function formatPath(directory: NavigationDirectorySummary): string {
  return directory.path ?? "—";
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
  const listboxId = useId();
  const errorId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
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
          props.value ? `Project: ${buttonLabel}` : "Choose a project"
        }
        className={`project-picker__trigger${
          isEmpty ? " is-empty" : " is-active"
        }`}
        disabled={props.disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <FolderIcon size={11} />
        <span className="project-picker__label">{buttonLabel}</span>
        <span className="project-picker__chevron" aria-hidden="true">
          ⌄
        </span>
      </button>

      {open ? (
        <div className="project-picker__pop" role="dialog" aria-label="Project picker">
          <div className="project-picker__search">
            <input
              type="text"
              autoFocus
              placeholder="Search directories"
              className="project-picker__search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

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

          <div className="project-picker__separator" />

          <button
            type="button"
            className="project-picker__row project-picker__row--action"
            disabled={props.picking}
            onClick={() => {
              setOpen(false);
              props.onPickFromDisk();
            }}
          >
            <span aria-hidden="true" className="project-picker__plus">
              +
            </span>
            <span className="project-picker__row-name">
              {props.picking ? "Picking…" : "Add directory…"}
            </span>
          </button>

          {props.pickError ? (
            <p
              id={errorId}
              role="alert"
              className="project-picker__error"
            >
              {props.pickError}
            </p>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
