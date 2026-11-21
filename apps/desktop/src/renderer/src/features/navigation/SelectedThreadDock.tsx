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
// The top dock's band: the card, 6px of plate above it and 6px below.
const DOCK_PLATE_PX = 6;
// The card's height before it has been drawn once: two lines at the default
// density. The first layout pass after it mounts replaces this.
const DOCK_HEIGHT_GUESS_PX = 46;
// Set on the region while the dock is at the top. Everything that sticks to
// the top of the list sticks this far down instead, under the dock.
const RESERVE_PROPERTY = "--selected-thread-dock-reserve";

type DockState = {
  edge: DockEdge;
  /** From the region's top to the list's top edge, for the top dock. */
  top: number;
  /** From the list's bottom edge to the region's, for the bottom dock. */
  bottom: number;
  /** The lane's reserved scrollbar gutter, which rows stay clear of. */
  gutter: number;
  /** The project the docked row sits under, in the Directories lens. */
  directoryKey: string | undefined;
  /**
   * Whether the arrow can say which way the thread is. It cannot when the
   * lens lists neither the thread nor anything that holds it.
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

function threadRows(region: HTMLElement, threadKey: string): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>(
    `.thread-row-shell[data-thread-key="${CSS.escape(threadKey)}"] > .thread-row`,
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
 * What stands where the thread's row would be when it has none: the rows of
 * the nearest parent thread that has any, else every project section that
 * lists it. A thread in two projects has a holder in each.
 */
function holdersOf(region: HTMLElement, holders: Holders): HTMLElement[] {
  for (const key of holders.ancestorThreadKeys) {
    const rows = threadRows(region, key);
    if (rows.length > 0) {
      return rows;
    }
  }
  return holders.directoryKeys.flatMap((key) => [...region.querySelectorAll<HTMLElement>(
    `.directory-row[data-directory-key="${CSS.escape(key)}"]`,
  )]);
}

function isProjectSection(element: Element): boolean {
  return element.classList.contains("directory-row");
}

// A closed project that holds the open thread draws its header selected. An
// open one shows nothing for a thread it has not drawn a row for: one past
// the loaded page, or under a collapsed Directory threads divider.
function speaksForThread(holder: Element): boolean {
  return !isProjectSection(holder)
    || holder.querySelector(".directory-row__summary[aria-expanded='false']") !== null;
}

/**
 * `reserve` is how far the top dock already holds the list's sticky headers
 * down, so the rects read here are in that layout. The dock then leaves only
 * when the row shows below those shifted headers, and comes back only when
 * the row is lost under the unshifted ones: showing it never uncovers the
 * row and hiding it never covers the row, so the two cannot alternate.
 */
function measure(
  region: HTMLElement,
  threadKey: string,
  holders: Holders,
  reserve: number,
): { state: DockState; row: HTMLElement | undefined } | undefined {
  // A drag reads the list's edges for auto-scroll and drop targets.
  if (region.querySelector(".is-pointer-dragging, .is-folding-directories")) {
    return undefined;
  }
  // A row kept mounted at no height is not a row the operator can find.
  const rows = threadRows(region, threadKey)
    .filter((row) => row.getBoundingClientRect().height > 0);
  const lane = rows[0] ? sidebarLaneOf(rows[0]) : laneOf(region);
  if (!lane) {
    return undefined;
  }
  const view = lane.getBoundingClientRect();
  // A hidden sidebar measures zero.
  if (view.height <= 0) {
    return undefined;
  }
  const held = rows.length === 0 ? holdersOf(region, holders) : [];
  const targets = held.length > 0 ? held : rows;
  const extents = targets.map(extentOf);
  // Where the list starts for its rows: under the top dock when it is up.
  const listTop = view.top + reserve;
  const nearTop = extents.some((extent) => extent.top < listTop + STICKY_REACH_PX);
  const stuckTop = nearTop
    ? stuckBandTop(
      listTop,
      [...lane.querySelectorAll(STICKY_HEADER)].map(extentOf),
      [...lane.querySelectorAll(STICKY_DIVIDER)].map(extentOf),
    )
    : listTop;
  // What counts as in view. A row under the stuck header is not. A project's
  // section is: the header stuck there is its own, or it has scrolled past.
  const bandTop = held[0] && isProjectSection(held[0]) ? listTop : stuckTop;
  const band = { top: bandTop, bottom: view.bottom };
  const placement = selectedThreadDockPlacement(extents, band);
  const holder = placement ? held[placement.index] : held[0];
  // A row in view speaks for itself, and so does what holds a hidden row: a
  // closed project that holds the open thread draws its header selected.
  // Only a thread the lens lists nowhere docks with nothing out of view.
  if (!placement && (rows.length > 0 || held.some((element, index) =>
    speaksForThread(element) && !selectedThreadDockPlacement([extents[index]!], band)))) {
    return undefined;
  }
  const edge = placement?.edge ?? "bottom";
  const row = placement && held.length === 0 ? rows[placement.index] : undefined;
  const regionBox = region.getBoundingClientRect();
  return {
    row,
    state: {
      edge,
      // The top dock sits at the list's own top edge, above every stuck
      // header. Under them it moved whenever one of them did: down as a
      // Directory threads divider stuck, then up a pixel at a time as it left.
      top: view.top - regionBox.top,
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
 * At the top it sits above the stuck project header, which moves down to
 * make room: the dock's place is then the list's own edge, and no header
 * arriving or leaving under it can move it.
 *
 * A thread with no row in the list docks too: one inside a collapsed parent
 * or a closed project, or one the lens does not list. It then stands in for
 * whatever would hold the row once that has scrolled out, and a click opens
 * it and scrolls to the row.
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
  const cardRef = useRef<HTMLButtonElement>(null);
  const reserveRef = useRef(0);
  // The thread whose hidden row the dock was asked to reveal. Focus follows
  // to that row when it arrives, as it does for a row the dock scrolls to.
  const focusOnArrivalRef = useRef<string | undefined>(undefined);

  const sync = useCallback((): void => {
    const region = regionRef.current;
    const measured = region && threadKey
      ? measure(region, threadKey, {
        ancestorThreadKeys: ancestorsKey ? ancestorsKey.split("\n") : [],
        directoryKeys: directoriesKey ? directoriesKey.split("\n") : [],
      }, reserveRef.current)
      : undefined;
    rowRef.current = measured?.row;
    // Set here, with the decision, not in an effect of its own: the next
    // measure must read rects laid out for the reserve it is told about.
    const reserve = measured?.state.edge === "top"
      ? (cardRef.current?.offsetHeight || DOCK_HEIGHT_GUESS_PX) + 2 * DOCK_PLATE_PX
      : 0;
    if (region && reserve !== reserveRef.current) {
      reserveRef.current = reserve;
      if (reserve > 0) {
        region.style.setProperty(RESERVE_PROPERTY, `${reserve}px`);
      } else {
        region.style.removeProperty(RESERVE_PROPERTY);
      }
    }
    if (focusOnArrivalRef.current !== undefined) {
      const arrived = region && focusOnArrivalRef.current === threadKey && !measured
        ? threadRows(region, threadKey)[0]
        : undefined;
      if (arrived || focusOnArrivalRef.current !== threadKey) {
        focusOnArrivalRef.current = undefined;
      }
      // Only from <body>, where the unmounted dock left it.
      if (arrived && document.activeElement === document.body) {
        arrived.querySelector<HTMLElement>(".thread-row__open")?.focus({ preventScroll: true });
      }
    }
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
      region.style.removeProperty(RESERVE_PROPERTY);
      reserveRef.current = 0;
    };
  }, [regionRef, sync, threadKey]);

  if (!dock || !props.thread) {
    return null;
  }
  const project = props.projectLabel(dock.directoryKey);
  const title = props.thread.title;
  // No `aria-label`: the card's own text names it (title, time, project), and
  // a label that leaves any of it out fails WCAG 2.5.3 Label in Name.
  return (
    <>
    {dock.edge === "top" ? (
      // The list's rows pass under the dock; this keeps them out of sight
      // in the strip the stuck headers have moved down from.
      <span
        aria-hidden="true"
        className="selected-thread-dock-band"
        style={{ "--selected-thread-dock-top": `${dock.top}px` } as CSSProperties}
      />
    ) : null}
    <button
      ref={cardRef}
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
          focusOnArrivalRef.current = threadKey;
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
    </>
  );
}
