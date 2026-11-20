import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { ArrowUpIcon, FolderIcon } from "../../icons";
import { ThreadRowStatus, type ThreadRowStatusKind } from "./ThreadRowStatus";
import { centerSidebarThreadRow, sidebarLaneOf } from "./reveal-selected-thread-row";
import {
  selectedThreadDockPlacement,
  stuckBandTop,
  type DockEdge,
  type DockExtent,
} from "./selected-thread-dock";
import { formatRelativeTime } from "./thread-time";

// What sticks to the top of a lane and covers the rows under it: a project
// or Pinned header, and a project's Directory threads divider below it.
const STICKY_HEADER = ".directory-row__header";
const STICKY_DIVIDER = ".directory-row__thread-divider";
// Nothing sticks lower than this, so a row further down needs no header scan.
const STICKY_REACH_PX = 160;

type DockState = {
  edge: DockEdge;
  /** From the region's top to the dock's edge of the list, for the top dock. */
  top: number;
  /** From the list's bottom edge to the region's, for the bottom dock. */
  bottom: number;
  /** The lane's reserved scrollbar gutter, which rows stay clear of. */
  gutter: number;
  /** The project the docked row sits under, in the Directories lens. */
  directoryKey: string | undefined;
  /**
   * Whether the arrow can say which way the thread is. It cannot when the
   * thread has no row and what would hold it is in view, or is not listed.
   */
  directed: boolean;
};

type SelectedThreadDockProps = {
  /** The sidebar's lane region. The dock floats over the list inside it. */
  regionRef: RefObject<HTMLDivElement | null>;
  thread: NavigationThreadSummary | undefined;
  threadKey: string | undefined;
  status: ThreadRowStatusKind | undefined;
  remoteWork: boolean;
  /**
   * The project name for the row the dock stands in for. The row's own
   * project header has usually scrolled away with it. `directoryKey` is the
   * project that row sits under, when the lens groups by project.
   */
  projectLabel: (directoryKey: string | undefined) => string | undefined;
  /**
   * What would hold the thread's row when it has none, nearest first: its
   * parent threads, whose collapsed rows hide it.
   */
  ancestorThreadKeys: readonly string[];
  /** And then the projects it is listed under, which may be closed. */
  directoryKeys: readonly string[];
  /**
   * Opens whatever hides the thread's row and scrolls to it. The dock calls
   * it when it has no row of its own to scroll to.
   */
  onRevealHiddenThread: () => void;
};

function extentOf(element: Element): DockExtent {
  const { top, bottom } = element.getBoundingClientRect();
  return { top, bottom };
}

function quoted(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

function threadRows(region: HTMLElement, threadKey: string): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>(
    `.thread-row-shell[data-thread-key="${quoted(threadKey)}"] > .thread-row`,
  )];
}

// The scrolling lane, found without a row to start from.
function laneOf(region: HTMLElement): HTMLElement | undefined {
  const first = region.querySelector<HTMLElement>(".thread-row-shell > .thread-row")
    ?? region.querySelector<HTMLElement>(".directory-row__header");
  return first ? sidebarLaneOf(first) : undefined;
}

type Holders = Pick<SelectedThreadDockProps, "ancestorThreadKeys" | "directoryKeys">;

/**
 * What stands where the thread's row would be when it has none: the nearest
 * parent thread with a row, else the project section that lists it.
 */
function holderOf(region: HTMLElement, holders: Holders): HTMLElement | undefined {
  for (const key of holders.ancestorThreadKeys) {
    const row = threadRows(region, key)[0];
    if (row) {
      return row;
    }
  }
  for (const key of holders.directoryKeys) {
    const section = region.querySelector<HTMLElement>(
      `.directory-row[data-directory-key="${quoted(key)}"]`,
    );
    if (section) {
      return section;
    }
  }
  return undefined;
}

function measure(
  region: HTMLElement,
  threadKey: string,
  holders: Holders,
): { state: DockState; row: HTMLElement | undefined } | undefined {
  // A drag reads the list's edges for auto-scroll and drop targets.
  if (region.querySelector(".is-pointer-dragging, .is-folding-directories")) {
    return undefined;
  }
  const rows = threadRows(region, threadKey);
  const lane = rows[0] ? sidebarLaneOf(rows[0]) : laneOf(region);
  if (!lane) {
    return undefined;
  }
  const view = lane.getBoundingClientRect();
  // A hidden sidebar measures zero.
  if (view.height <= 0) {
    return undefined;
  }
  const holder = rows.length === 0 ? holderOf(region, holders) : undefined;
  const extents = holder ? [extentOf(holder)] : rows.map(extentOf);
  const nearTop = extents.some((extent) => extent.top < view.top + STICKY_REACH_PX);
  const bandTop = nearTop
    ? stuckBandTop(
      view.top,
      [...lane.querySelectorAll(STICKY_HEADER)].map(extentOf),
      [...lane.querySelectorAll(STICKY_DIVIDER)].map(extentOf),
    )
    : view.top;
  const placement = selectedThreadDockPlacement(extents, { top: bandTop, bottom: view.bottom });
  // A row in view speaks for itself. A holder in view does not: the thread
  // is inside it, unseen, so the dock rests at the bottom and points nowhere.
  if (!placement && rows.length > 0) {
    return undefined;
  }
  const edge = placement?.edge ?? "bottom";
  const row = placement && !holder ? rows[placement.index] : undefined;
  const regionBox = region.getBoundingClientRect();
  return {
    row,
    state: {
      edge,
      // The headers above a row that is out of view below are not in its way.
      top: (edge === "top" ? bandTop : view.top) - regionBox.top,
      bottom: regionBox.bottom - view.bottom,
      gutter: lane.offsetWidth - lane.clientWidth,
      directoryKey: (row ?? holder)?.closest<HTMLElement>("[data-thread-directory-key]")
        ?.dataset.threadDirectoryKey
        ?? holder?.closest<HTMLElement>(".directory-row")?.dataset.directoryKey,
      directed: placement !== undefined,
    },
  };
}

function sameDock(a: DockState | undefined, b: DockState | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }
  return a.edge === b.edge
    && a.top === b.top
    && a.bottom === b.bottom
    && a.gutter === b.gutter
    && a.directoryKey === b.directoryKey
    && a.directed === b.directed;
}

/**
 * The open thread, docked at the edge of the list its row scrolled out
 * through. Click it to bring the row back to the middle of the list.
 *
 * A thread with no row in the list docks too: one inside a collapsed parent
 * or a closed project, or one the lens does not list. It then stands in for
 * whatever would hold the row, and a click opens that and scrolls to it.
 *
 * It is a compact card, not a second `ThreadRow`: the row's chips are
 * controls, and a copy of them over the list would be a second place to
 * detach a PR. It floats over the list so that nothing moves when it
 * appears. See `selected-thread-dock.ts` for when it shows.
 */
export function SelectedThreadDock(props: SelectedThreadDockProps) {
  const { regionRef, threadKey } = props;
  // By value: the lists are rebuilt on every render of the sidebar.
  const ancestorsKey = props.ancestorThreadKeys.join("\n");
  const directoriesKey = props.directoryKeys.join("\n");
  const [dock, setDock] = useState<DockState>();
  const dockRef = useRef<DockState | undefined>(undefined);
  const rowRef = useRef<HTMLElement | undefined>(undefined);

  const sync = useCallback((): void => {
    const region = regionRef.current;
    const measured = region && threadKey
      ? measure(region, threadKey, {
        ancestorThreadKeys: ancestorsKey ? ancestorsKey.split("\n") : [],
        directoryKeys: directoriesKey ? directoriesKey.split("\n") : [],
      })
      : undefined;
    rowRef.current = measured?.row;
    // Compared here, not in a state updater: an updater that returns the
    // same state still schedules a render, and this runs on every scroll
    // frame and every list mutation.
    if (!sameDock(dockRef.current, measured?.state)) {
      dockRef.current = measured?.state;
      setDock(measured?.state);
    }
  }, [ancestorsKey, directoriesKey, regionRef, threadKey]);

  // Every render: the selection, the lens and the rows all reach here as a
  // render, and the first paint after one must not show a stale dock.
  useLayoutEffect(sync);

  // And what moves rows without a render: a scroll, a resize, and rows that
  // mount inside a list which keeps its own state.
  useEffect(() => {
    const region = regionRef.current;
    if (!region || !threadKey) {
      return undefined;
    }
    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) {
        return;
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        sync();
      });
    };
    // Scroll events do not bubble; the lane inside the region scrolls.
    region.addEventListener("scroll", schedule, { capture: true, passive: true });
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(schedule) : undefined;
    resize?.observe(region);
    const mutation = typeof MutationObserver === "function"
      ? new MutationObserver(schedule)
      : undefined;
    mutation?.observe(region, { childList: true, subtree: true });
    return () => {
      window.cancelAnimationFrame(frame);
      region.removeEventListener("scroll", schedule, { capture: true });
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [regionRef, sync, threadKey]);

  if (!dock || !props.thread) {
    return null;
  }
  const project = props.projectLabel(dock.directoryKey);
  const title = props.thread.title;
  return (
    <button
      aria-label={`Scroll to selected thread: ${title}${project ? `, in ${project}` : ""}`}
      className={`selected-thread-dock selected-thread-dock--${dock.edge}`}
      data-edge={dock.edge}
      data-testid="selected-thread-dock"
      style={{
        "--selected-thread-dock-top": `${dock.top}px`,
        "--selected-thread-dock-bottom": `${dock.bottom}px`,
        "--selected-thread-dock-gutter": `${dock.gutter}px`,
      } as CSSProperties}
      type="button"
      onClick={() => {
        const row = rowRef.current;
        if (!row?.isConnected) {
          props.onRevealHiddenThread();
          return;
        }
        centerSidebarThreadRow(row);
        // The dock unmounts once the row is back, which would drop focus to
        // <body>. The row's open button is the same thread's control.
        row.querySelector<HTMLElement>(".thread-row__open")?.focus({ preventScroll: true });
      }}
    >
      <span className="selected-thread-dock__line">
        <ThreadRowStatus remoteWork={props.remoteWork} status={props.status} />
        <span className="thread-row__title selected-thread-dock__title">{title}</span>
        <span className="thread-row__time">{formatRelativeTime(props.thread.updatedAt)}</span>
      </span>
      <span className="selected-thread-dock__line selected-thread-dock__line--where">
        {project ? (
          <span className="selected-thread-dock__project">
            <FolderIcon size={12} aria-hidden="true" />
            <span className="selected-thread-dock__project-label">{project}</span>
          </span>
        ) : null}
        {dock.directed ? (
          <span aria-hidden="true" className="selected-thread-dock__direction">
            <ArrowUpIcon size={12} />
          </span>
        ) : null}
      </span>
    </button>
  );
}
