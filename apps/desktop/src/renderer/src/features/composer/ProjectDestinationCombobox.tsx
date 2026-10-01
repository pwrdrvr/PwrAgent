import type { NavigationDirectoryView as NavigationDirectorySummary } from "../../lib/navigation-loaded-rows";
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { FolderIcon } from "../../icons";
import { filterDirectoryReferenceCandidates } from "../../lib/directory-references";
import { getHomeDir, tildifyPath } from "../../lib/tildify-path";
import { useDismissableLayer } from "../../lib/useDismissableLayer";
import { HighlightedAutocompleteLabel } from "./HighlightedAutocompleteLabel";

/**
 * Destination field for the composer's Move to Project dialog.
 *
 * One text field that is also the search: typing narrows the thread
 * owner's tracked projects in the same compact list the composer's `@`
 * autocomplete draws, and picking a row fills in its path. A typed
 * absolute path is still a valid destination on its own.
 *
 * A local thread also gets the `@` popover's "Add directory…" row, which
 * opens the native folder dialog. A remote thread does not: that dialog can
 * only browse this machine, which is the wrong machine for a federated
 * thread. There is never an "Add file…" row, because a file is not a project.
 *
 * `directories` must already belong to the thread's owner. The parent
 * drops a page answered by any other instance.
 */
export type ProjectDestinationComboboxProps = {
  /** The input's id, so the dialog's visible caption can label it. */
  id?: string;
  value: string;
  onChange: (path: string) => void;
  /** Owner-side search for a bounded directory page. */
  onQueryChange: (query: string) => void;
  directories: readonly NavigationDirectorySummary[];
  /** The owner has answered at least once, so an empty list means none. */
  loaded: boolean;
  /** The owner could not answer the search. */
  error?: string;
  disabled?: boolean;
  /** Browse for a folder on this machine. Pass it only for a local thread. */
  onPickDirectory?: () => void;
  /**
   * The owner is another instance. Its paths are shown as they are: the
   * local home directory says nothing about where a peer's `~` is.
   */
  remote: boolean;
};

function isDestination(directory: NavigationDirectorySummary): boolean {
  // Only real projects. The synthesized "Workspaces" collector and the
  // "unlinked" bucket are not Git checkouts a conversation can move into.
  return directory.kind === "directory" && Boolean(directory.path);
}

export function ProjectDestinationCombobox(props: ProjectDestinationComboboxProps): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  const candidates = useMemo(
    () => filterDirectoryReferenceCandidates(props.directories.filter(isDestination), query),
    [props.directories, query],
  );
  // The browse row is the last item, so the arrow keys reach it too.
  const pickIndex = props.onPickDirectory ? candidates.length : undefined;
  const itemCount = candidates.length + (pickIndex === undefined ? 0 : 1);
  const active = Math.min(activeIndex, itemCount - 1);
  const empty = props.loaded && candidates.length === 0
    ? (query.trim() ? "No matching projects." : "No tracked projects yet.")
    : undefined;
  // Nothing to draw until the owner answers: no empty box under the field,
  // and no invisible layer taking the Escape meant for the dialog.
  const showList = open && !props.disabled && (itemCount > 0 || Boolean(props.error) || Boolean(empty));

  // A layer, not a keydown handler on the input: the dialog around this
  // field owns Escape otherwise, and one press would close both.
  useDismissableLayer({
    open: showList,
    onDismiss: () => setOpen(false),
    surfaceRef: containerRef,
    triggerRef: inputRef,
  });

  const formatPath = (path: string): string =>
    tildifyPath(path, props.remote ? undefined : getHomeDir());

  const select = (directory: NavigationDirectorySummary): void => {
    props.onChange(directory.path ?? "");
    setOpen(false);
  };

  const pickDirectory = (): void => {
    setOpen(false);
    props.onPickDirectory?.();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        setActiveIndex(0);
        return;
      }
      if (itemCount === 0) {
        return;
      }
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((active + step + itemCount) % itemCount);
      return;
    }
    if (event.key === "Enter" && showList && active >= 0) {
      event.preventDefault();
      if (active === pickIndex) {
        pickDirectory();
      } else if (candidates[active]) {
        select(candidates[active]);
      }
    }
  };

  return (
    <div ref={containerRef} className="project-destination">
      <input
        ref={inputRef}
        aria-activedescendant={showList && active >= 0 ? `${listboxId}-option-${active}` : undefined}
        aria-autocomplete="list"
        aria-controls={showList ? listboxId : undefined}
        aria-expanded={showList}
        aria-label="Destination project"
        autoComplete="off"
        id={props.id}
        className="workspace-handoff-dialog__text-input"
        disabled={props.disabled}
        placeholder="Search projects or enter a path"
        role="combobox"
        spellCheck={false}
        type="text"
        value={props.value}
        onBlur={(event) => {
          if (!containerRef.current?.contains(event.relatedTarget as Node | null)) {
            setOpen(false);
          }
        }}
        onChange={(event) => {
          const next = event.target.value;
          props.onChange(next);
          props.onQueryChange(next);
          setQuery(next);
          setActiveIndex(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        onMouseDown={() => setOpen(true)}
      />
      {showList ? (
        <div className="composer__autocomplete composer__autocomplete--directories composer__autocomplete--below project-destination__list">
          {props.error ? (
            <div className="project-picker__error" role="alert">
              {props.error}
            </div>
          ) : empty ? (
            <div className="project-picker__empty">{empty}</div>
          ) : null}
          <div aria-label="Projects" id={listboxId} role="listbox">
            {candidates.map((directory, index) => (
              <button
                key={directory.key}
                aria-selected={index === active}
                className={`composer__autocomplete-option${index === active ? " is-active" : ""}`}
                id={`${listboxId}-option-${index}`}
                role="option"
                tabIndex={-1}
                title={directory.path}
                type="button"
                onMouseDown={(event) => {
                  // Keep focus in the field so the list's keyboard state holds.
                  event.preventDefault();
                }}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(directory)}
              >
                <span className="composer__autocomplete-title">
                  <FolderIcon size={13} aria-hidden="true" />
                  <HighlightedAutocompleteLabel
                    label={directory.label}
                    matchAnywhere
                    query={query.trim()}
                  />
                </span>
                <span className="composer__autocomplete-meta">
                  {formatPath(directory.path ?? "")}
                </span>
              </button>
            ))}
            {pickIndex === undefined ? null : (
              <>
                {candidates.length > 0 ? (
                  // Decorative: a listbox may own only options.
                  <div aria-hidden="true" className="composer__autocomplete-separator" />
                ) : null}
                <button
                  aria-selected={active === pickIndex}
                  className={`composer__autocomplete-option composer__autocomplete-option--action${active === pickIndex ? " is-active" : ""}`}
                  id={`${listboxId}-option-${pickIndex}`}
                  role="option"
                  tabIndex={-1}
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                  }}
                  onMouseEnter={() => setActiveIndex(pickIndex)}
                  onClick={pickDirectory}
                >
                  <span className="composer__autocomplete-title">+ Add directory…</span>
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
