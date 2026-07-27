import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";
import type { NavigationDirectorySummary } from "@pwragent/shared";
import { FileCodeIcon, FolderIcon, SearchIcon } from "../../icons";
import { tildifyPath } from "../../lib/tildify-path";

/**
 * Combined reference picker for the composer's setup-row "+" button.
 *
 * Two tabs:
 *   - "Projects": recent tracked directories (same filter/sort as the
 *     ProjectPicker — `latestUpdatedAt` desc, capped, pickable kinds
 *     only). Clicking a row mints a directory-reference chip.
 *   - "Files": recently referenced files, persisted by the main process
 *     and loaded lazily by the parent. Clicking a row attaches the file
 *     to the composer tray.
 *
 * The bottom action row is platform-aware: macOS can combine files and
 * directories in ONE OS dialog (`onPickFromDisk`), while Windows/Linux
 * dialogs cannot, so those platforms keep separate "Add directory…" /
 * "Add file…" actions.
 *
 * The picker is a controlled popover: the parent owns the open state
 * (its trigger button renders as `children` inside the anchor span so
 * the outside-click handler here treats trigger clicks as inside —
 * otherwise a pointerdown-close followed by the trigger's click-toggle
 * would immediately reopen it). Escape and outside clicks call
 * `onClose`; the parent also closes before opening any OS dialog.
 */
export type ReferencePickerFile = {
  label: string;
  path: string;
};

export type ReferencePickerProps = {
  /** Whether the popover is open. The trigger child always renders. */
  open: boolean;
  onClose: () => void;
  /** The trigger button — rendered inside the anchor span. */
  children?: ReactNode;
  /** All tracked directories from the navigation snapshot. */
  directories: NavigationDirectorySummary[];
  /** Recently referenced files, most-recent-first (loaded by parent). */
  recentFiles: ReferencePickerFile[];
  /** `process.platform` from the desktop bridge ("darwin", "win32", …). */
  platform?: string;
  onSelectDirectory: (directory: { label: string; path: string }) => void;
  onSelectFile: (path: string) => void;
  /** macOS-only combined file-or-directory OS dialog. */
  onPickFromDisk?: () => void;
  /** Separate OS dialogs for platforms without a combined dialog. */
  onPickDirectoryFromDisk?: () => void;
  onPickFileFromDisk?: () => void;
};

const RECENTS_LIMIT = 10;

type ReferencePickerTab = "projects" | "files";

function formatDirectoryLabel(directory: NavigationDirectorySummary): string {
  return (
    directory.label
    || (directory.path ? tildifyPath(directory.path) : directory.key)
  );
}

function isPickableDirectory(directory: NavigationDirectorySummary): boolean {
  // Mirror ProjectPicker: the "unlinked" pseudo-directory isn't a folder
  // the user picked. A reference chip also needs a real path.
  return directory.kind !== "unlinked" && Boolean(directory.path);
}

export function ReferencePicker(props: ReferencePickerProps): ReactElement {
  const [tab, setTab] = useState<ReferencePickerTab>("projects");
  const [query, setQuery] = useState("");
  const [menuShift, setMenuShift] = useState(0);
  const containerRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!props.open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        props.onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [props.open, props.onClose]);

  // The popover is anchored to the trigger, which sits near the right edge of
  // the composer toolbar — keep it inside the viewport by nudging it back in
  // when it would overflow either gutter (same clamp as the BranchPicker).
  // Runs before paint so there's no visible jump, and re-clamps on resize
  // while open. Keeping the panel in-viewport is what lets it FLOAT over the
  // transcript: an off-viewport panel would make the focused search input
  // scroll overflow-hidden ancestors sideways to chase it, shoving the whole
  // chat surface under the sidebar.
  useLayoutEffect(() => {
    if (!props.open) {
      setMenuShift(0);
      return;
    }
    const clamp = (): void => {
      const menu = menuRef.current;
      if (!menu) {
        return;
      }
      const gutter = 12;
      const rect = menu.getBoundingClientRect();
      const overflowRight = rect.right - (window.innerWidth - gutter);
      const overflowLeft = gutter - rect.left;
      setMenuShift((current) => {
        if (overflowRight > 0) {
          return current - overflowRight;
        }
        if (overflowLeft > 0) {
          return current + overflowLeft;
        }
        return current;
      });
    };
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [props.open]);

  // Focus the search input AFTER the clamp above has positioned the panel
  // (not via `autoFocus`, which fires during commit, before layout effects).
  // `preventScroll` is belt-and-braces: focus must never scroll ancestor
  // containers to reveal the input — that's the layout shove this popover
  // is specifically built to avoid.
  useEffect(() => {
    if (!props.open) {
      return;
    }
    const frame = window.requestAnimationFrame(() =>
      inputRef.current?.focus({ preventScroll: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [props.open]);

  const trimmedQuery = query.trim().toLowerCase();

  const sortedDirectories = useMemo(() => {
    const pickable = props.directories.filter(isPickableDirectory);
    const ordered = [...pickable].sort(
      (left, right) => (right.latestUpdatedAt ?? 0) - (left.latestUpdatedAt ?? 0),
    );
    const top = ordered.slice(0, RECENTS_LIMIT);
    if (!trimmedQuery) {
      return top;
    }
    return top.filter((directory) => {
      const label = formatDirectoryLabel(directory).toLowerCase();
      const path = (directory.path ?? "").toLowerCase();
      return label.includes(trimmedQuery) || path.includes(trimmedQuery);
    });
  }, [props.directories, trimmedQuery]);

  const filteredFiles = useMemo(() => {
    if (!trimmedQuery) {
      return props.recentFiles;
    }
    return props.recentFiles.filter(
      (file) =>
        file.label.toLowerCase().includes(trimmedQuery)
        || file.path.toLowerCase().includes(trimmedQuery),
    );
  }, [props.recentFiles, trimmedQuery]);

  const useCombinedPicker =
    props.platform === "darwin" && Boolean(props.onPickFromDisk);

  return (
    <span
      ref={containerRef}
      className="reference-picker"
      data-state={props.open ? "open" : "closed"}
    >
      {props.children}

      {props.open ? (
        <div
          className="reference-picker__pop"
          ref={menuRef}
          role="dialog"
          aria-label="Add reference"
          style={
            menuShift ? { transform: `translateX(${menuShift}px)` } : undefined
          }
        >
          <div
            className="reference-picker__tabs"
            role="tablist"
            aria-label="Reference kinds"
          >
            <button
              type="button"
              role="tab"
              id={`${panelId}-tab-projects`}
              aria-selected={tab === "projects"}
              aria-controls={`${panelId}-panel-projects`}
              className={`reference-picker__tab${
                tab === "projects" ? " is-active" : ""
              }`}
              onClick={() => setTab("projects")}
            >
              Projects
            </button>
            <button
              type="button"
              role="tab"
              id={`${panelId}-tab-files`}
              aria-selected={tab === "files"}
              aria-controls={`${panelId}-panel-files`}
              className={`reference-picker__tab${
                tab === "files" ? " is-active" : ""
              }`}
              onClick={() => setTab("files")}
            >
              Files
            </button>
          </div>

          <div className="reference-picker__search">
            <span aria-hidden="true" className="reference-picker__search-icon">
              <SearchIcon size={13} />
            </span>
            <input
              type="text"
              ref={inputRef}
              placeholder={
                tab === "projects" ? "Find a directory" : "Find a file"
              }
              className="reference-picker__search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>

          {tab === "projects" ? (
            <ul
              className="reference-picker__list"
              id={`${panelId}-panel-projects`}
              role="listbox"
              aria-labelledby={`${panelId}-tab-projects`}
            >
              {sortedDirectories.length === 0 ? (
                <li className="reference-picker__empty">
                  {trimmedQuery ? "No matches." : "No tracked directories yet."}
                </li>
              ) : (
                sortedDirectories.map((directory) => (
                  <li key={directory.key}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="reference-picker__row"
                      onClick={() => {
                        if (!directory.path) {
                          return;
                        }
                        props.onSelectDirectory({
                          label: formatDirectoryLabel(directory),
                          path: directory.path,
                        });
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className="reference-picker__row-icon"
                      >
                        <FolderIcon size={13} />
                      </span>
                      <span className="reference-picker__row-name">
                        {formatDirectoryLabel(directory)}
                      </span>
                      <span className="reference-picker__row-path">
                        {directory.path ? tildifyPath(directory.path) : "—"}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : (
            <ul
              className="reference-picker__list"
              id={`${panelId}-panel-files`}
              role="listbox"
              aria-labelledby={`${panelId}-tab-files`}
            >
              {filteredFiles.length === 0 ? (
                <li className="reference-picker__empty">
                  {trimmedQuery
                    ? "No matches."
                    : "No recent files. Drop files on the composer or add one below."}
                </li>
              ) : (
                filteredFiles.map((file) => (
                  <li key={file.path}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      className="reference-picker__row"
                      onClick={() => props.onSelectFile(file.path)}
                    >
                      <span
                        aria-hidden="true"
                        className="reference-picker__row-icon"
                      >
                        <FileCodeIcon size={13} />
                      </span>
                      <span className="reference-picker__row-name">
                        {file.label}
                      </span>
                      <span className="reference-picker__row-path">
                        {tildifyPath(file.path)}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          )}

          <div className="reference-picker__separator" />

          {useCombinedPicker ? (
            <button
              type="button"
              className="reference-picker__row reference-picker__row--action"
              onClick={() => props.onPickFromDisk?.()}
            >
              <span aria-hidden="true" className="reference-picker__plus">
                +
              </span>
              <span className="reference-picker__row-name">
                Add file or directory…
              </span>
            </button>
          ) : (
            <>
              {props.onPickDirectoryFromDisk ? (
                <button
                  type="button"
                  className="reference-picker__row reference-picker__row--action"
                  onClick={() => props.onPickDirectoryFromDisk?.()}
                >
                  <span aria-hidden="true" className="reference-picker__plus">
                    +
                  </span>
                  <span className="reference-picker__row-name">
                    Add directory…
                  </span>
                </button>
              ) : null}
              {props.onPickFileFromDisk ? (
                <button
                  type="button"
                  className="reference-picker__row reference-picker__row--action"
                  onClick={() => props.onPickFileFromDisk?.()}
                >
                  <span aria-hidden="true" className="reference-picker__plus">
                    +
                  </span>
                  <span className="reference-picker__row-name">Add file…</span>
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </span>
  );
}
