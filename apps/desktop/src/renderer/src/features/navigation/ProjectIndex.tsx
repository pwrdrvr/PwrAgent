import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { PauseIcon, PinIcon } from "../../icons";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";
import {
  resolveDirectoryDrop,
  type DirectoryDrop,
  type DirectoryDropBox,
} from "./directory-pin-drop";
import { useDropIndicatorController } from "./drag-drop";
import { beginPointerReorderDrag, type Point, type PointerReorderTarget } from "./pointer-reorder-drag";
import {
  clampProjectIndexWidth,
  NO_PROJECT_SPY,
  PROJECT_INDEX_KEYBOARD_STEP,
  projectTypeaheadIndex,
  sameProjectSpy,
  spyProjects,
  type ProjectBlockBox,
  type ProjectSpy,
} from "./project-index";
import { matchMoveHotkey } from "./thread-action-hotkeys";

export type ProjectIndexEntry = {
  key: string;
  label: string;
  /** Holds the open thread or launchpad: drawn in the accent, like its row. */
  containsSelection: boolean;
  /** A turn is running on this machine in one of its threads. */
  active: boolean;
  /** A turn is running on a peer instance in one of its threads. */
  activeRemote?: boolean;
  /** One of its threads finished a turn the operator has not read. */
  review: boolean;
  /** Forge Automation is paused for the project. */
  forgeActivityPaused?: boolean;
  /** Pinned: listed above the hairline, in the operator's order. */
  pinned?: boolean;
  /** Can be pinned, so it can be dragged. */
  movable?: boolean;
};

/** How long typed letters keep building one typeahead query. */
const TYPEAHEAD_MS = 600;

/** How long a dropped name keeps its outline. Matches the list's reveal. */
const DROP_FLASH_MS = 1200;

/** Read the Directories lens's project sections, in px from the list's top
 *  edge. The section is measured, not its sticky header: a stuck header
 *  reports where it is stuck, not where its project is. */
function measureBlocks(list: HTMLElement): ProjectBlockBox[] {
  const top = list.getBoundingClientRect().top;
  const boxes: ProjectBlockBox[] = [];
  for (const section of list.querySelectorAll<HTMLElement>(
    "section.directory-row[data-directory-key]",
  )) {
    const key = section.dataset["directoryKey"];
    if (key === undefined) continue;
    const rect = section.getBoundingClientRect();
    boxes.push({ key, top: rect.top - top, bottom: rect.bottom - top });
  }
  return boxes;
}

/**
 * The name-only column beside the thread list.
 *
 * It owns its scroll-spy state, so a scroll re-renders this column and not
 * the sidebar. A jump is the sidebar's job (the list owns open state); this
 * only says which project was asked for.
 */
export const ProjectIndex = memo(function ProjectIndex(props: {
  projects: readonly ProjectIndexEntry[];
  /** The sidebar's lane region. The Directories list scrolls inside it. */
  scrollRegionRef: RefObject<HTMLDivElement | null>;
  /** The lane region's id, for each item's `aria-controls`. */
  scrollRegionId: string;
  /** Follow the list's scroll. Only the Directories lens is in project order. */
  spy: boolean;
  /** A dragged width in px, or `null` for the width of the longest name. */
  width: number | null;
  onWidthChange: (width: number | null) => void;
  onJump: (key: string) => void;
  /** The project's own menu, the one its header opens. Absent: no menu. */
  onOpenContextMenu?: (
    key: string,
    position: { x: number; y: number; anchorTop: number },
  ) => void;
  /** Apply a dropped name, as a Directories folder drop. Absent: no drag. */
  onDropProject?: (key: string, drop: DirectoryDrop) => void;
  /** ⌘⇧↑/↓ on a pinned name. */
  onMoveProject?: (key: string, direction: "up" | "down") => void;
}): ReactElement {
  const { scrollRegionRef, spy: spyEnabled } = props;
  const tooltip = useViewportTooltip({ className: "viewport-tooltip", placement: "beside" });
  const navRef = useRef<HTMLElement | null>(null);
  const [spy, setSpy] = useState<ProjectSpy>(NO_PROJECT_SPY);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  // A name moved by ⌘⇧↑/↓, until its new place renders. React reorders by
  // moving <li>s, and Chromium drops focus from a node it moves, so ⌘⇧↓
  // would leave focus on <body>. The move lands after a round trip to the
  // owner, so this waits for the reorder instead of refocusing at once.
  const movedRef = useRef<{ key: string; from: number } | null>(null);
  const pointerInside = useRef(false);
  const typed = useRef<{ query: string; at: number }>({ query: "", at: 0 });

  // ---- Width: natural until dragged ----
  // The bounds are read back from the column's computed min-width (its
  // 7-character floor) and max-width (the sidebar's width past the list's
  // floor), so a drag can never push the list below the width it is built
  // for. Double-click returns to the natural width.
  const [box, setBox] = useState({ width: 0, min: 0, max: 0 });
  const readBox = useCallback((): { width: number; min: number; max: number } => {
    const nav = navRef.current;
    if (nav === null) return { width: 0, min: 0, max: 0 };
    const style = getComputedStyle(nav);
    const min = parseFloat(style.minWidth) || 0;
    const max = parseFloat(style.maxWidth);
    return {
      width: nav.getBoundingClientRect().width,
      min,
      max: Number.isFinite(max) ? max : min,
    };
  }, []);
  const syncBox = useCallback((): void => {
    const next = readBox();
    setBox((prev) =>
      prev.width === next.width && prev.min === next.min && prev.max === next.max
        ? prev
        : next);
  }, [readBox]);
  useLayoutEffect(syncBox, [syncBox, props.width]);
  useEffect(() => {
    const nav = navRef.current;
    if (nav === null || typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(syncBox);
    observer.observe(nav);
    // The sidebar's width moves the cap (max-width) without always moving
    // the column, so watch the row it sits in too.
    if (nav.parentElement?.parentElement) observer.observe(nav.parentElement.parentElement);
    return () => observer.disconnect();
  }, [syncBox]);

  const onWidthChange = props.onWidthChange;
  // Arrow keys move the column at once and save once, when the key is
  // released (or focus leaves): a held key repeats about 30 times a second,
  // and each save rewrites config.toml.
  const pendingKeyWidth = useRef<number | null>(null);
  const nudgeWidth = (delta: number): void => {
    const nav = navRef.current;
    if (nav === null) return;
    const { width, min, max } = readBox();
    const next = clampProjectIndexWidth(width + delta, min, max);
    nav.style.width = `${next}px`;
    pendingKeyWidth.current = next;
    syncBox();
  };
  const commitKeyWidth = (): void => {
    const next = pendingKeyWidth.current;
    if (next === null) return;
    pendingKeyWidth.current = null;
    if (next !== props.width) onWidthChange(next);
  };
  const resetWidth = (): void => {
    pendingKeyWidth.current = null;
    if (props.width !== null) {
      onWidthChange(null);
    } else if (navRef.current) {
      navRef.current.style.width = "";
    }
  };
  const startResize = (event: ReactPointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    const nav = navRef.current;
    if (nav === null) return;
    const startX = event.clientX;
    const { width: startWidth, min, max } = readBox();
    // Null until the pointer moves: a press alone (or the first half of a
    // double-click) must not save the natural width as a dragged one.
    let last: number | null = null;
    let frame = 0;
    // The drag writes the column's width straight to the DOM, once a frame,
    // and commits once on release: the setting write re-renders the shell.
    const flush = (): void => {
      frame = 0;
      if (last !== null) nav.style.width = `${last}px`;
    };
    const move = (moveEvent: PointerEvent): void => {
      last = clampProjectIndexWidth(startWidth + moveEvent.clientX - startX, min, max);
      if (frame === 0) frame = window.requestAnimationFrame(flush);
    };
    const stop = (): void => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      flush();
      document.body.classList.remove("is-project-index-resizing");
      if (last !== null) onWidthChange(last);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    document.body.classList.add("is-project-index-resizing");
  };

  const keys = props.projects.map((project) => project.key);
  const keysKey = keys.join("\n");

  const measure = useCallback((): void => {
    if (!spyEnabled) {
      setSpy((prev) => (sameProjectSpy(prev, NO_PROJECT_SPY) ? prev : NO_PROJECT_SPY));
      return;
    }
    const list = scrollRegionRef.current?.querySelector<HTMLElement>(".directory-list");
    if (!list) return;
    const next = spyProjects(measureBlocks(list), list.clientHeight);
    setSpy((prev) => (sameProjectSpy(prev, next) ? prev : next));
  }, [scrollRegionRef, spyEnabled]);

  // Follow the list: on scroll (one read per frame), and whenever the list
  // changes height under a still scroll position — a project opening or
  // closing, a page loading. The list is a descendant of the region and is
  // remounted with the lens, so the scroll is caught on the way down.
  useEffect(() => {
    const region = scrollRegionRef.current;
    if (!region || !spyEnabled) return undefined;
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    region.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : null;
    resize?.observe(region);
    const list = region.querySelector(".directory-list");
    if (list) {
      resize?.observe(list);
      for (const child of list.children) resize?.observe(child);
    }
    return () => {
      window.cancelAnimationFrame(frame);
      region.removeEventListener("scroll", schedule, { capture: true });
      resize?.disconnect();
    };
  }, [measure, scrollRegionRef, spyEnabled, keysKey]);
  // And when the lens or the project set changes what is listed.
  useLayoutEffect(measure, [measure, keysKey]);

  // Keep the current project in view in the index, but never while the
  // operator is in it: an item must not move under the pointer, and a
  // keyboard walk owns the index's scroll.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (nav === null || spy.current === null) return;
    if (pointerInside.current || nav.contains(document.activeElement)) return;
    const item = findItem(nav, spy.current);
    if (item === null) return;
    const navRect = nav.getBoundingClientRect();
    const rect = item.getBoundingClientRect();
    if (rect.top < navRect.top) nav.scrollTop += rect.top - navRect.top;
    else if (rect.bottom > navRect.bottom) nav.scrollTop += rect.bottom - navRect.bottom;
  }, [spy.current]);

  const selectedKey = props.projects.find((project) => project.containsSelection)?.key;
  const tabStop =
    (focusedKey !== null && keys.includes(focusedKey) ? focusedKey : null)
    ?? spy.current
    ?? selectedKey
    ?? keys[0]
    ?? null;

  const focusAt = (index: number): void => {
    const key = keys[index];
    const nav = navRef.current;
    if (key === undefined || nav === null) return;
    setFocusedKey(key);
    findItem(nav, key)?.focus();
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>): void => {
    const target = event.target as HTMLElement;
    const at = keys.indexOf(target.dataset["projectKey"] ?? "");
    if (at === -1) return;
    const direction = props.onMoveProject && props.projects[at]?.pinned
      ? matchMoveHotkey(event)
      : null;
    if (direction !== null) {
      event.preventDefault();
      const to = direction === "up" ? at - 1 : at + 1;
      if (props.projects[to]?.pinned) movedRef.current = { key: keys[at]!, from: at };
      props.onMoveProject?.(keys[at]!, direction);
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      focusAt(Math.min(at + 1, keys.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      focusAt(Math.max(at - 1, 0));
    } else if (event.key === "Home") {
      event.preventDefault();
      focusAt(0);
    } else if (event.key === "End") {
      event.preventDefault();
      focusAt(keys.length - 1);
    } else if (
      event.key.length === 1
      && event.key !== " "
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
    ) {
      const now = Date.now();
      const query = now - typed.current.at > TYPEAHEAD_MS
        ? event.key
        : typed.current.query + event.key;
      typed.current = { query, at: now };
      const hit = projectTypeaheadIndex(
        props.projects.map((project) => project.label),
        at,
        query,
      );
      if (hit !== -1) {
        event.preventDefault();
        focusAt(hit);
      }
    }
  };

  // A name the column cut short gets a hover card with all of it.
  const showIfCut = (target: HTMLElement): void => {
    const label = target.querySelector<HTMLElement>(".project-index__label");
    if (label && label.scrollWidth > label.clientWidth) {
      tooltip.show(target, label.textContent ?? "");
    }
  };

  // ---- Drag a name to reorder the pins ----
  // The folder drag's parts (`beginPointerReorderDrag`): a 4px lift, the
  // tilted held card, the dimmed source, the insertion line, Escape to cancel.
  // The list does not move while a name is held; the index is already one
  // line per project.
  const dropIndicator = useDropIndicatorController();
  const dragDisposeRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragDisposeRef.current?.(), []);
  const [pinSlotOpen, setPinSlotOpen] = useState(false);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  useEffect(() => {
    if (flashKey === null) return undefined;
    const timer = window.setTimeout(() => setFlashKey(null), DROP_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashKey]);
  useLayoutEffect(() => {
    const moved = movedRef.current;
    const nav = navRef.current;
    if (moved === null || nav === null) return;
    const at = props.projects.findIndex((project) => project.key === moved.key);
    if (at === moved.from) return;
    movedRef.current = null;
    const active = document.activeElement;
    if (at !== -1 && (active === null || active === document.body)) {
      findItem(nav, moved.key)?.focus({ preventScroll: true });
    }
  }, [props.projects]);
  const pinnedCount = props.projects.filter((project) => project.pinned).length;
  const lastPinned = props.projects.findLastIndex((project) => project.pinned);
  // The hairline follows the last pin. It is drawn even with nothing below
  // it while a pin can be dragged out, as the Directories divider is.
  const showSeam = lastPinned >= 0
    && (lastPinned < props.projects.length - 1 || Boolean(props.onDropProject));

  const beginDrag = (
    event: ReactPointerEvent<HTMLElement>,
    project: ProjectIndexEntry,
  ): void => {
    const nav = navRef.current;
    const onDropProject = props.onDropProject;
    const item = event.currentTarget.closest<HTMLElement>("li");
    if (event.button !== 0 || nav === null || item === null || !onDropProject) return;
    dragDisposeRef.current?.();
    const sourcePinned = Boolean(project.pinned);
    // With nothing pinned there is no hairline to drop on, so a held name
    // opens the ghost Pin slot, as a pin drag opens Keep at top.
    const offersPinSlot = !sourcePinned && pinnedCount === 0;

    const resolveTarget = (point: Point): PointerReorderTarget<DirectoryDrop> | undefined => {
      const bounds = nav.getBoundingClientRect();
      if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom) {
        return undefined;
      }
      const rows = new Map<string, HTMLElement>();
      const items: DirectoryDropBox[] = [];
      for (const row of nav.querySelectorAll<HTMLElement>("li[data-project-row]")) {
        const key = row.dataset["projectRow"];
        if (key === undefined) continue;
        const rect = row.getBoundingClientRect();
        rows.set(key, row);
        items.push({ key, top: rect.top, bottom: rect.bottom, pinned: row.dataset["projectPinned"] === "true" });
      }
      const seam = nav.querySelector<HTMLElement>(".project-index__seam");
      const slot = nav.querySelector<HTMLElement>(".project-index__pin-slot");
      const seamRect = seam?.getBoundingClientRect();
      const slotRect = slot?.getBoundingClientRect();
      const hit = resolveDirectoryDrop({
        y: point.y,
        source: { key: project.key, pinned: sourcePinned },
        items,
        ...(seamRect ? { seam: { top: seamRect.top, bottom: seamRect.bottom } } : {}),
        ...(slotRect ? { pinSlot: { top: slotRect.top, bottom: slotRect.bottom } } : {}),
      });
      if (hit === undefined) return undefined;
      if (hit.kind === "line") {
        const anchor = rows.get(hit.anchorKey);
        if (anchor === undefined) return undefined;
        return {
          element: anchor,
          key: `project-index:${hit.anchorKey}`,
          position: hit.position,
          ...(hit.label ? { label: hit.label } : {}),
          value: hit.drop,
        };
      }
      const element = hit.kind === "seam" ? seam : slot;
      if (!element) return undefined;
      return { element, key: `project-index:${hit.kind}`, label: hit.label, value: hit.drop };
    };

    dragDisposeRef.current = beginPointerReorderDrag({
      event,
      sourceElement: item,
      previewSource: item,
      preview: { rowSelector: ".project-index__item", className: "project-index__drag-image" },
      clickSuppressionRoot: nav,
      scrollElement: nav,
      dropIndicator,
      resolveTarget,
      onLift: () => {
        tooltip.hide();
        // The slot opens once, above every name, and moves the names down
        // by its height, as Keep at top does. It must be in the DOM before
        // the first hit test, which runs on the next frame.
        if (offersPinSlot) flushSync(() => setPinSlotOpen(true));
      },
      onSettle: () => {
        if (offersPinSlot) setPinSlotOpen(false);
      },
      onDrop: ({ value }) => {
        setFlashKey(project.key);
        onDropProject(project.key, value);
      },
    });
  };

  const inView = new Set(spy.inView);

  return (
    <div className="project-index-pane">
      <nav
        ref={navRef}
        className="project-index"
        aria-label="Project index"
        style={props.width === null ? undefined : { width: props.width }}
        onKeyDown={onKeyDown}
        onPointerEnter={() => {
          pointerInside.current = true;
        }}
        onPointerLeave={() => {
          pointerInside.current = false;
        }}
      >
        <ul className="project-index__list">
          {pinSlotOpen ? (
            <li className="project-index__pin-slot-row" aria-hidden="true">
              <div className="project-index__pin-slot">
                <PinIcon size={10} />
                Pin
              </div>
            </li>
          ) : null}
          {props.projects.map((project, index) => {
            const current = project.key === spy.current;
            const movable = Boolean(project.movable && props.onDropProject);
            const row = (
              <li
                key={project.key}
                data-project-row={project.key}
                data-project-pinned={project.pinned ? "true" : "false"}
              >
                <button
                  type="button"
                  className={`project-index__item${current ? " is-current" : ""}${
                    !current && inView.has(project.key) ? " is-in-view" : ""
                  }${project.containsSelection ? " is-selected" : ""}${
                    flashKey === project.key ? " is-revealed" : ""
                  }`}
                  data-project-key={project.key}
                  tabIndex={project.key === tabStop ? 0 : -1}
                  aria-controls={props.scrollRegionId}
                  aria-current={current ? "location" : undefined}
                  // "Jump to" keeps the name apart from the project's own
                  // header button, which carries the bare label. The marks
                  // are decoration beside the name, so the name says what
                  // they mean.
                  aria-label={`Jump to ${project.label}${
                    project.active || project.activeRemote
                      ? `${project.active ? ", turn running" : ""}${
                        project.activeRemote ? ", turn running on another instance" : ""
                      }`
                      : project.review ? ", unread" : ""
                  }${project.forgeActivityPaused ? ", forge activity paused" : ""}`}
                  onClick={() => {
                    tooltip.hide();
                    props.onJump(project.key);
                  }}
                  onContextMenu={props.onOpenContextMenu
                    ? (event) => {
                        event.preventDefault();
                        tooltip.hide();
                        props.onOpenContextMenu?.(project.key, {
                          x: event.clientX,
                          y: event.clientY,
                          anchorTop: event.currentTarget.getBoundingClientRect().top,
                        });
                      }
                    : undefined}
                  onPointerDown={movable ? (event) => beginDrag(event, project) : undefined}
                  onMouseEnter={(event) => showIfCut(event.currentTarget)}
                  onMouseLeave={tooltip.hide}
                  onFocus={(event) => {
                    setFocusedKey(project.key);
                    showIfCut(event.currentTarget);
                  }}
                  onBlur={tooltip.hide}
                >
                  <span className="project-index__label">{project.label}</span>
                  {project.active || project.activeRemote ? (
                    // Local above remote, as the Attention tab stacks them.
                    <span className="project-index__mark" aria-hidden="true">
                      {project.active ? <ThinkingScanner compact /> : null}
                      {project.activeRemote ? (
                        <span className="project-index__mark-remote">
                          <ThinkingScanner compact />
                        </span>
                      ) : null}
                    </span>
                  ) : project.review ? (
                    <span className="project-index__mark" aria-hidden="true">
                      <span className="thread-row__status-cookie" />
                    </span>
                  ) : null}
                  {project.forgeActivityPaused ? (
                    <span
                      aria-hidden="true"
                      className="project-index__paused tooltip-target"
                      data-tooltip="Forge activity paused"
                    >
                      <PauseIcon size={11} strokeWidth={2.5} />
                    </span>
                  ) : null}
                </button>
              </li>
            );
            // The hairline where the pins end: a mark for the eye and the
            // Unpin target for the pointer, hidden from screen readers.
            return showSeam && index === lastPinned
              ? [row, <li key="project-index:seam" className="project-index__seam" aria-hidden="true" />]
              : row;
          })}
        </ul>
      </nav>
      <div
        aria-label="Resize project index"
        aria-orientation="vertical"
        aria-valuenow={Math.round(box.width)}
        aria-valuemin={Math.round(box.min)}
        aria-valuemax={Math.round(box.max)}
        className="project-index__grip"
        role="separator"
        tabIndex={0}
        onDoubleClick={resetWidth}
        onBlur={commitKeyWidth}
        onKeyUp={(event) => {
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") commitKeyWidth();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            nudgeWidth(-PROJECT_INDEX_KEYBOARD_STEP);
          } else if (event.key === "ArrowRight") {
            event.preventDefault();
            nudgeWidth(PROJECT_INDEX_KEYBOARD_STEP);
          }
        }}
        onPointerDown={startResize}
      />
      {tooltip.tooltipNode}
    </div>
  );
});

/** Compared, never interpolated into a selector: keys carry whatever a path
 *  does. */
function findItem(nav: HTMLElement, key: string): HTMLElement | null {
  for (const element of nav.querySelectorAll<HTMLElement>("[data-project-key]")) {
    if (element.dataset["projectKey"] === key) return element;
  }
  return null;
}
