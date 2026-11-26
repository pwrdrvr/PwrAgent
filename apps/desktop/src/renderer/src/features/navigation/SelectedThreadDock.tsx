import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import { flushSync } from "react-dom";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { ArrowUpIcon, FolderIcon } from "../../icons";
import { ThreadRowStatus, type ThreadRowStatusKind } from "./ThreadRowStatus";
import { centerSidebarThreadRow } from "./reveal-selected-thread-row";
import {
  selectedThreadDockPlacement,
  stuckBandTop,
  type DockEdge,
  type DockExtent,
} from "./selected-thread-dock";
import {
  THREAD_DOCK_DRAG_LIFT_EVENT,
  TOP_DOCK_CLASS,
  TOP_DOCK_RESERVE_CHANGE_EVENT,
  TOP_DOCK_RESERVE_PROPERTY as RESERVE_PROPERTY,
  TOP_DOCK_RESERVE_SAMPLE_EVENT,
  clearTopDockReserve,
  topDockReserve,
} from "./selected-thread-dock-reserve";
import { formatRelativeTime } from "./thread-time";

// What sticks to the top of a lane and covers the rows under it: a project
// or Pinned header, and a project's Directory threads divider below it.
const STICKY_HEADER = ".directory-row__header";
const STICKY_DIVIDER = ".directory-row__thread-divider";
// The project header and divider fit in this strip at supported densities.
const STICKY_REACH_PX = 160;
const DRAGGING = ".is-pointer-dragging, .is-folding-directories";
const STICKY_MEMBERS = `${STICKY_HEADER}, ${STICKY_DIVIDER}`;
const TARGET_MEMBERS = ".thread-row-shell, .thread-row, .directory-row, .directory-row__header";
const DOCK_MEMBERS = ".selected-thread-dock, .selected-thread-dock-band";
const LANE = ".sidebar-list--dense";
const LANE_CONTENT = ".thread-row-shell > .thread-row, .directory-row__header";
// The top dock's band: the card, 6px of plate above it and 6px below.
const DOCK_PLATE_PX = 6;
// The card's height before it has been drawn once: two lines at the default
// density. The first layout pass after it mounts replaces this.
const DOCK_HEIGHT_GUESS_PX = 46;

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

function unreservedStickyExtent(element: Element, listTop: number, reserve: number, zoom: number): DockExtent {
  const extent = extentOf(element);
  if (reserve === 0 || extent.top <= listTop || extent.bottom === extent.top) return extent;

  const divider = element.matches(STICKY_DIVIDER);
  const baseInset = divider
    ? Number.parseFloat(getComputedStyle(element).getPropertyValue("--directory-row-header-height"))
    : 0;
  const stickyTop = listTop + baseInset * zoom;
  // The box is already leaving its section, or has not reached the sticky
  // inset even with the reserve. Allow for Chromium snapping the sticky
  // inset to a layout unit before it reports the rectangle.
  if (!(extent.top > stickyTop && extent.top <= stickyTop + reserve + 1)) return extent;

  // A sticky box can only move down from its normal position. Its current
  // top is already capped by the end of the containing section, so lowering
  // the inset just clamps it between its normal position and the base inset.
  const origin = divider ? element.previousElementSibling : element.parentElement;
  if (!origin) return extent;
  const flowInset = divider ? 0 : origin.clientTop + Number.parseFloat(getComputedStyle(origin).paddingTop || "0");
  const flowTop = origin.getBoundingClientRect().top + flowInset * zoom;
  const top = Math.max(stickyTop, Math.min(extent.top, flowTop));
  return { top, bottom: top + (extent.bottom - extent.top) };
}

function threadRows(region: HTMLElement, threadKey: string): HTMLElement[] {
  return [...region.querySelectorAll<HTMLElement>(
    `.thread-row-shell[data-thread-key="${CSS.escape(threadKey)}"] > .thread-row`,
  )];
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

type DockElements = {
  dragging?: boolean;
  rows?: HTMLElement[];
  hasContent?: boolean;
  holders?: HTMLElement[];
  sticky?: { headers: Element[]; dividers: Element[] };
};

/**
 * Cache the list's members, whose identity can survive many commits. Read
 * extents fresh because even a commit with the same members can move rows.
 */
function measure(
  region: HTMLElement,
  lane: HTMLElement,
  threadKey: string,
  holders: Holders,
  elements: DockElements,
  reserve: number,
  revealPending: boolean,
): { state?: DockState; row?: HTMLElement } | undefined {
  // A drag reads the list's edges for auto-scroll and drop targets.
  elements.dragging ??= lane.matches(DRAGGING) || lane.querySelector(DRAGGING) !== null;
  if (elements.dragging) {
    return undefined;
  }
  const candidates = elements.rows ??= threadRows(lane, threadKey);
  elements.hasContent ??= candidates.length > 0 || lane.querySelector(LANE_CONTENT) !== null;
  if (!elements.hasContent) {
    return undefined;
  }
  const view = lane.getBoundingClientRect();
  // A hidden sidebar measures zero.
  if (view.height <= 0) {
    return undefined;
  }
  const rows: HTMLElement[] = [];
  const extents: DockExtent[] = [];
  for (const row of candidates) {
    const extent = extentOf(row);
    // A row kept mounted at no height is not a row the operator can find.
    if (extent.bottom > extent.top) {
      rows.push(row);
      extents.push(extent);
    }
  }
  const held = rows.length === 0 ? elements.holders ??= holdersOf(lane, holders) : [];
  for (const holder of held) {
    extents.push(extentOf(holder));
  }
  const listTop = view.top;
  let bandTop = listTop;
  // A project holder uses the lane itself as its band. And when all targets
  // are above a lane with room for its sticky band, increasing the band's
  // top cannot make any target visible or change their order of nearness.
  if (!(held[0] && isProjectSection(held[0]))
    && extents.some((extent) => extent.top < listTop + STICKY_REACH_PX)
    && !(view.height > STICKY_REACH_PX && extents.every((extent) => extent.bottom <= listTop))) {
    // Resolve sticky boxes without the reserve they acquire from the dock.
    // Otherwise a row at the very start could stay covered forever.
    if (!elements.sticky) {
      elements.sticky = {
        headers: [...lane.querySelectorAll(STICKY_HEADER)],
        dividers: [...lane.querySelectorAll(STICKY_DIVIDER)],
      };
    }
    // Computed insets use CSS pixels, while the client rectangles include
    // the effective CSS zoom of the lane.
    const zoom = lane.currentCSSZoom ?? 1;
    const stickyEdge = reserve > 0 ? listTop + lane.clientTop * zoom : listTop;
    bandTop = stuckBandTop(listTop, elements.sticky.headers, elements.sticky.dividers,
      (element) => unreservedStickyExtent(element, stickyEdge, reserve * zoom, zoom));
  }
  const band = { top: bandTop, bottom: view.bottom };
  const placement = selectedThreadDockPlacement(extents, band);
  const holder = placement ? held[placement.index] : held[0];
  // A row in view speaks for itself, and so does what holds a hidden row: a
  // closed project that holds the open thread draws its header selected.
  // Only a thread the lens lists nowhere docks with nothing out of view.
  if (!placement && rows.length > 0) {
    // The row that came into view may be a later alias of the same thread.
    return revealPending && band.bottom > band.top
      ? { row: rows.find((_, index) => !selectedThreadDockPlacement([extents[index]!], band)) }
      : undefined;
  }
  if (!placement && held.some((element, index) =>
    speaksForThread(element) && !selectedThreadDockPlacement([extents[index]!], band))) {
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

/**
 * React can commit several child pages before the browser presents a frame.
 * Keep their geometry work with scrolling, once per frame. A changed lane
 * establishes a new baseline synchronously, as does a changed selection.
 */
function observeDockLayout(
  region: HTMLElement,
  cardRef: RefObject<HTMLButtonElement | null>,
  initialSync: (lane: HTMLElement | undefined, elements: DockElements | undefined, inFrame: boolean) => void,
  cardMounted: (measuredHeight?: number) => void,
) {
  let sync = initialSync;
  let elements: DockElements = {};
  let lane: HTMLElement | undefined;
  let observedCard: HTMLButtonElement | null;
  let initialized = false;
  let frame = 0;
  let layoutSample: "pending" | "sampled" | undefined;
  const observedSizes = new WeakMap<Element, { inline: number; block: number }>();
  const containsMatch = (node: Element, selector: string): boolean =>
    node.matches(selector) || node.querySelector(selector) !== null;
  const forgetTargets = (): void => {
    elements.rows = undefined;
    elements.holders = undefined;
    elements.hasContent = undefined;
  };
  const noteMutations = (records: MutationRecord[]): boolean => {
    let changed = false;
    for (const record of records) {
      if ((record.target instanceof Element ? record.target : record.target.parentElement)?.closest(DOCK_MEMBERS)) {
        continue;
      }
      if (record.type === "childList") {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node instanceof Element) {
            if (node.matches(DOCK_MEMBERS)) continue;
            if (elements.sticky && containsMatch(node, STICKY_MEMBERS)) elements.sticky = undefined;
            if (elements.rows && containsMatch(node, TARGET_MEMBERS)) forgetTargets();
            if (elements.dragging || containsMatch(node, DRAGGING)) elements.dragging = undefined;
          }
          changed = true;
        }
      } else if (record.target !== region) {
        if (record.attributeName === "data-thread-key" || record.attributeName === "data-directory-key") {
          forgetTargets();
        } else if (record.attributeName === "class" && record.target instanceof Element
          && (elements.dragging || record.target.matches(DRAGGING))) {
          elements.dragging = undefined;
        }
        changed = true;
      }
    }
    return changed;
  };
  const cancelMeasure = (): void => {
    if (frame !== 0) {
      window.cancelAnimationFrame(frame);
      frame = 0;
    }
    layoutSample = undefined;
  };
  const refresh = (inFrame = false, forceMeasure = false): void => {
    // Each lens renders one lane directly inside the region. Identify it
    // without probing the computed overflow of a newly mounted row's ancestors.
    const nextLane = Array.from(region.children).find((child): child is HTMLElement =>
      child instanceof HTMLElement && child.matches(LANE));
    const replaced = !initialized || lane !== nextLane;
    if (replaced) {
      cancelMeasure();
      mutation?.takeRecords();
      if (lane) {
        resize?.unobserve(lane);
        observedSizes.delete(lane);
      }
      lane = nextLane;
      elements = {};
      if (lane) resize?.observe(lane);
      initialized = true;
    }
    if (replaced || forceMeasure || !mutation || inFrame) {
      if ((inFrame || forceMeasure) && mutation) noteMutations(mutation.takeRecords());
      sync(lane, mutation ? elements : {}, inFrame);
    }
    if (observedCard !== cardRef.current) {
      if (observedCard) {
        resize?.unobserve(observedCard);
        observedSizes.delete(observedCard);
      }
      observedCard = cardRef.current;
      if (observedCard) {
        resize?.observe(observedCard, { box: "border-box" });
        // When ResizeObserver is present, avoid forcing a synchronous layout
        // via offsetHeight right after flushSync; ResizeObserver delivers the
        // card's border-box blockSize directly without a sync reflow.
        if (!resize) cardMounted();
      }
    }
  };
  const sampleLayout = (): void => {
    if (layoutSample !== "pending") return;
    // The Project Index may need the reserve before our observer runs. Its
    // request performs the same sample and leaves the delivery accounted for.
    layoutSample = "sampled";
    refresh(true);
  };
  const schedule = (): void => {
    if (frame !== 0 || layoutSample === "pending") return;
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (!resize) {
        refresh(true);
        return;
      }
      // Animation callbacks run before layout. A fresh observation delivers
      // after layout in this same rendering update, even on a pure scroll.
      // Reuse the region's observation so it still reports later resizes.
      layoutSample = "pending";
      resize.unobserve(region);
      resize.observe(region);
    });
  };
  const resize = typeof ResizeObserver === "function" ? new ResizeObserver((entries) => {
    if (entries && entries.length > 0) {
      let cardHeightChanged: number | undefined;
      let geometryChanged = false;
      for (const entry of entries) {
        const box = entry.borderBoxSize?.[0] ?? entry.contentBoxSize?.[0];
        if (entry.target === observedCard) {
          const block = box?.blockSize;
          const prev = observedSizes.get(entry.target);
          if (block !== undefined && block > 0) {
            if (!prev || prev.block !== block) {
              observedSizes.set(entry.target, { inline: box?.inlineSize ?? 0, block });
              cardHeightChanged = block;
            }
          } else {
            geometryChanged = true;
          }
          continue;
        }
        if (!box) {
          geometryChanged = true;
          continue;
        }
        const prev = observedSizes.get(entry.target);
        if (!prev) {
          observedSizes.set(entry.target, { inline: box.inlineSize, block: box.blockSize });
          // The initial observation after refresh() already measured this box.
          if (!initialized) geometryChanged = true;
        } else if (prev.inline !== box.inlineSize || prev.block !== box.blockSize) {
          observedSizes.set(entry.target, { inline: box.inlineSize, block: box.blockSize });
          geometryChanged = true;
        }
      }
      if (cardHeightChanged !== undefined) {
        cardMounted(cardHeightChanged);
      }
      if (layoutSample === undefined) {
        if (geometryChanged) schedule();
        return;
      }
    } else if (layoutSample === undefined) {
      schedule();
      return;
    }
    sampleLayout();
    layoutSample = undefined;
  }) : undefined;
  const mutation = typeof MutationObserver === "function" ? new MutationObserver((records) => {
    if (noteMutations(records)) schedule();
  }) : undefined;
  resize?.observe(region);
  mutation?.observe(region, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-expanded", "class", "data-directory-key", "data-thread-key", "style"],
  });
  mutation?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-density"] });
  document.fonts?.addEventListener("loadingdone", schedule);
  const onScroll = (event: Event): void => {
    if (event.target === lane) schedule();
  };
  // Drag targets are hit-tested before the after-layout sample. Removing
  // the dock needs no geometry, and the drag class still controls its return.
  const onDragLift = (): void => sync(undefined, undefined, true);
  region.addEventListener("scroll", onScroll, { capture: true, passive: true });
  region.addEventListener(TOP_DOCK_RESERVE_SAMPLE_EVENT, sampleLayout);
  region.addEventListener(THREAD_DOCK_DRAG_LIFT_EVENT, onDragLift);
  return {
    refresh,
    setSync(nextSync: typeof initialSync) {
      sync = nextSync;
      forgetTargets();
    },
    dispose() {
      cancelMeasure();
      region.removeEventListener("scroll", onScroll, { capture: true });
      region.removeEventListener(TOP_DOCK_RESERVE_SAMPLE_EVENT, sampleLayout);
      region.removeEventListener(THREAD_DOCK_DRAG_LIFT_EVENT, onDragLift);
      resize?.disconnect();
      mutation?.disconnect();
      document.fonts?.removeEventListener("loadingdone", schedule);
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
export const SelectedThreadDock = memo(function SelectedThreadDock(props: SelectedThreadDockProps) {
  const { regionRef, threadKey } = props;
  // By value: the lists are rebuilt on every render of the sidebar.
  const ancestorsKey = props.ancestorThreadKeys.join("\n");
  const directoriesKey = props.directoryKeys.join("\n");
  const [dock, setDock] = useState<DockState>();
  const dockRef = useRef<DockState | undefined>(undefined);
  const rowRef = useRef<HTMLElement | undefined>(undefined);
  const cardRef = useRef<HTMLButtonElement>(null);
  const measuredCardHeightRef = useRef<number | undefined>(undefined);
  // The region that carries the reserve, to take it back from on unmount.
  // The property stays on it between top docks; only the class comes and goes.
  const reservedRegionRef = useRef<HTMLElement | undefined>(undefined);
  // The thread whose hidden row the dock was asked to reveal. Focus follows
  // to that row when it arrives, as it does for a row the dock scrolls to.
  const focusOnArrivalRef = useRef<string | undefined>(undefined);

  const updateReserve = useCallback((edge: DockEdge | undefined, measuredHeight?: number): void => {
    const region = regionRef.current;
    const reserved = reservedRegionRef.current;
    const reserveBefore = region ? topDockReserve(region) : 0;
    if (reserved && reserved !== region) {
      reserved.classList.remove(TOP_DOCK_CLASS);
      reserved.style.removeProperty(RESERVE_PROPERTY);
      reservedRegionRef.current = undefined;
    }
    if (measuredHeight !== undefined && measuredHeight > 0) {
      measuredCardHeightRef.current = measuredHeight;
    }
    const cardHeight = measuredHeight
      ?? measuredCardHeightRef.current
      ?? (cardRef.current?.offsetHeight || DOCK_HEIGHT_GUESS_PX);
    const reserve = edge === "top"
      ? cardHeight + 2 * DOCK_PLATE_PX
      : 0;
    if (region && reserve > 0) {
      const value = `${reserve}px`;
      if (region.style.getPropertyValue(RESERVE_PROPERTY) !== value) {
        region.style.setProperty(RESERVE_PROPERTY, value);
      }
      if (!region.classList.contains(TOP_DOCK_CLASS)) region.classList.add(TOP_DOCK_CLASS);
      reservedRegionRef.current = region;
    } else if (region && reserved === region) {
      clearTopDockReserve(region);
      return;
    }
    if (region && topDockReserve(region) !== reserveBefore) {
      region.dispatchEvent(new Event(TOP_DOCK_RESERVE_CHANGE_EVENT));
    }
  }, [regionRef]);

  const sync = useCallback((lane?: HTMLElement, elements?: DockElements, inFrame = false): void => {
    const region = regionRef.current;
    const revealPending = focusOnArrivalRef.current !== undefined && focusOnArrivalRef.current === threadKey;
    const measured = region && lane && threadKey && elements
      ? measure(region, lane, threadKey, {
        ancestorThreadKeys: ancestorsKey ? ancestorsKey.split("\n") : [],
        directoryKeys: directoriesKey ? directoriesKey.split("\n") : [],
      }, elements, topDockReserve(region), revealPending)
      : undefined;
    const next = measured?.state;
    rowRef.current = next ? measured?.row : undefined;
    updateReserve(next?.edge);
    if (focusOnArrivalRef.current !== undefined) {
      const arrived = revealPending && !next ? measured?.row : undefined;
      if (arrived || !revealPending) {
        focusOnArrivalRef.current = undefined;
      }
      // Transfer focus from the keyboard-activated card or from <body>
      // when the card has already unmounted.
      if (arrived && (document.activeElement === cardRef.current || document.activeElement === document.body)) {
        arrived.querySelector<HTMLElement>(".thread-row__open")?.focus({ preventScroll: true });
      }
    }
    // Compared here, not in a state updater: an updater that returns the
    // same state still schedules a render, and this runs on every scroll
    // frame and every list mutation.
    if (!sameDock(dockRef.current, next)) {
      dockRef.current = next;
      // When geometry changes the edge, publish the card in this frame.
      // Ordinary scroll and child-page measurements schedule no React work.
      if (inFrame) flushSync(() => setDock(next));
      else setDock(next);
    }
  }, [ancestorsKey, directoriesKey, regionRef, threadKey, updateReserve]);

  const layoutRef = useRef<({
    region: HTMLElement;
    sync: typeof sync;
  } & ReturnType<typeof observeDockLayout>) | undefined>(undefined);

  const refreshLayout = (): void => {
    const region = regionRef.current;
    const layout = layoutRef.current;
    let targetChanged = false;
    if (layout?.region !== region || Boolean(layout) !== Boolean(region && threadKey)) {
      layout?.dispose();
      layoutRef.current = region && threadKey
        ? { region, sync, ...observeDockLayout(region, cardRef, sync, (measuredHeight) => {
          if (dockRef.current?.edge === "top") updateReserve("top", measuredHeight);
        }) }
        : undefined;
    } else if (layout && layout.sync !== sync) {
      layout.sync = sync;
      layout.setSync(sync);
      targetChanged = true;
    }
    if (layoutRef.current) layoutRef.current.refresh(false, targetChanged);
    else sync();
  };

  // Keep synchronous geometry for a new selection or lane. The observer
  // batches updates to the live lane with the next scroll frame.
  useLayoutEffect(refreshLayout);
  useEffect(() => {
    // On mount the enclosing host ref can attach after our layout effect.
    if (!layoutRef.current && regionRef.current && threadKey) refreshLayout();
  });

  useLayoutEffect(() => () => {
    layoutRef.current?.dispose();
    layoutRef.current = undefined;
    const reserved = reservedRegionRef.current;
    reservedRegionRef.current = undefined;
    if (!reserved) return;
    const hadReserve = topDockReserve(reserved) > 0;
    reserved.classList.remove(TOP_DOCK_CLASS);
    reserved.style.removeProperty(RESERVE_PROPERTY);
    if (hadReserve) reserved.dispatchEvent(new Event(TOP_DOCK_RESERVE_CHANGE_EVENT));
  }, []);

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
});
