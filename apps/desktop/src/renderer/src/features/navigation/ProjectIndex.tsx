import {
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
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";
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

export type ProjectIndexEntry = {
  key: string;
  label: string;
  /** Holds the open thread or launchpad: drawn in the accent, like its row. */
  containsSelection: boolean;
  /** A turn is running in one of its threads. */
  active: boolean;
  /** One of its threads finished a turn the operator has not read. */
  review: boolean;
};

/** How long typed letters keep building one typeahead query. */
const TYPEAHEAD_MS = 600;

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
export function ProjectIndex(props: {
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
}): ReactElement {
  const { scrollRegionRef, spy: spyEnabled } = props;
  const tooltip = useViewportTooltip({ className: "viewport-tooltip", placement: "beside" });
  const navRef = useRef<HTMLElement | null>(null);
  const [spy, setSpy] = useState<ProjectSpy>(NO_PROJECT_SPY);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
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
  const nudgeWidth = (delta: number): void => {
    const { width, min, max } = readBox();
    onWidthChange(clampProjectIndexWidth(width + delta, min, max));
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
          {props.projects.map((project) => {
            const current = project.key === spy.current;
            return (
              <li key={project.key}>
                <button
                  type="button"
                  className={`project-index__item${current ? " is-current" : ""}${
                    !current && inView.has(project.key) ? " is-in-view" : ""
                  }${project.containsSelection ? " is-selected" : ""}`}
                  data-project-key={project.key}
                  tabIndex={project.key === tabStop ? 0 : -1}
                  aria-controls={props.scrollRegionId}
                  aria-current={current ? "location" : undefined}
                  onClick={() => {
                    tooltip.hide();
                    props.onJump(project.key);
                  }}
                  onMouseEnter={(event) => showIfCut(event.currentTarget)}
                  onMouseLeave={tooltip.hide}
                  onFocus={(event) => {
                    setFocusedKey(project.key);
                    showIfCut(event.currentTarget);
                  }}
                  onBlur={tooltip.hide}
                >
                  <span className="project-index__label">{project.label}</span>
                  {project.active ? (
                    <span className="project-index__mark" role="img" aria-label="Turn running">
                      <ThinkingScanner compact />
                    </span>
                  ) : project.review ? (
                    <span className="project-index__mark" role="img" aria-label="Unread">
                      <span aria-hidden="true" className="thread-row__status-cookie" />
                    </span>
                  ) : null}
                </button>
              </li>
            );
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
        onDoubleClick={() => onWidthChange(null)}
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
}

/** Compared, never interpolated into a selector: keys carry whatever a path
 *  does. */
function findItem(nav: HTMLElement, key: string): HTMLElement | null {
  for (const element of nav.querySelectorAll<HTMLElement>("[data-project-key]")) {
    if (element.dataset["projectKey"] === key) return element;
  }
  return null;
}
