import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ExpandIcon, PinIcon } from "../../icons";
import {
  canOfferColumnPin,
  computeHorizontalScrollEdges,
  computePinnedFirstColumnState,
  computeStickyHeaderState,
  type HorizontalScrollEdges,
  type PinFirstColumnRecommendation,
  type PinnedColumnState,
  type StickyHeaderState,
} from "./table-sticky-model";

export { computeHorizontalScrollEdges, type HorizontalScrollEdges };

export type TableStickyMode = "scroll-ancestor" | "native" | "none";

export type TableExpandContext = {
  pinnedFirstColumn: boolean;
  tableElement: HTMLTableElement | null;
};

type ObservedTable = {
  canPin: boolean;
  desiredPinned: boolean;
  scroller: HTMLDivElement;
  wrap: HTMLDivElement;
};

type ObservedEntryRecord = {
  lastInlineSize: number | undefined;
  table: ObservedTable;
};

let sharedResizeObserver: ResizeObserver | undefined;
const observedElements = new Map<Element, ObservedEntryRecord>();

function entryInlineSize(entry: ResizeObserverEntry): number | undefined {
  const box = Array.isArray(entry.borderBoxSize)
    ? entry.borderBoxSize[0]
    : entry.borderBoxSize;
  if (box && typeof box.inlineSize === "number" && Number.isFinite(box.inlineSize)) {
    return box.inlineSize;
  }
  const rectWidth = entry.contentRect?.width;
  return typeof rectWidth === "number" && Number.isFinite(rectWidth)
    ? rectWidth
    : undefined;
}

function measureFirstHeaderCellWidth(scroller: HTMLDivElement): number {
  const table = scroller.firstElementChild;
  if (!(table instanceof HTMLTableElement)) {
    return 0;
  }
  const firstCell = table.tHead?.rows[0]?.cells[0] ?? table.rows[0]?.cells[0];
  return firstCell ? firstCell.offsetWidth : 0;
}

function flushTableEdgeUpdates(tables: Iterable<ObservedTable>): void {
  // Two-phase read-then-write avoids O(K^2) interleaved forced layouts when
  // multiple tables resize in a single ResizeObserver batch.
  const updates: Array<{
    canScrollX: boolean;
    edges: HorizontalScrollEdges;
    pinned: PinnedColumnState;
    wrap: HTMLDivElement;
  }> = [];
  for (const table of tables) {
    const clientWidth = table.scroller.clientWidth;
    const scrollLeft = table.scroller.scrollLeft;
    const scrollWidth = table.scroller.scrollWidth;
    const edges = computeHorizontalScrollEdges({
      clientWidth,
      scrollLeft,
      scrollWidth,
    });
    const canScrollX = Number.isFinite(clientWidth)
      && Number.isFinite(scrollWidth)
      && scrollWidth - clientWidth > 1;
    const firstColumnWidth = table.canPin && table.desiredPinned && canScrollX
      ? measureFirstHeaderCellWidth(table.scroller)
      : 0;
    const pinned = computePinnedFirstColumnState({
      clientWidth,
      desiredPinned: table.desiredPinned,
      eligible: table.canPin,
      firstColumnWidth,
      scrollLeft,
      scrollWidth,
    });
    updates.push({
      canScrollX,
      edges,
      pinned,
      wrap: table.wrap,
    });
  }
  for (const { canScrollX, edges, pinned, wrap } of updates) {
    applyBooleanAttribute(wrap, "data-scroll-left", edges.left);
    applyBooleanAttribute(wrap, "data-scroll-right", edges.right);
    applyBooleanAttribute(wrap, "data-can-scroll-x", canScrollX);
    applyBooleanAttribute(wrap, "data-pinned-col-active", pinned.active);
    applyBooleanAttribute(wrap, "data-pinned-col-scrolled", pinned.scrolledUnder);
  }
}

function observeTableElement(element: Element, table: ObservedTable): () => void {
  if (typeof ResizeObserver === "undefined") {
    return () => {};
  }
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      const dirty = new Set<ObservedTable>();
      for (const entry of entries) {
        const record = observedElements.get(entry.target);
        if (!record) {
          continue;
        }
        const inlineSize = entryInlineSize(entry);
        // Streaming row appends grow table height without changing width; skip
        // layout reads when inlineSize is unchanged.
        if (inlineSize !== undefined && inlineSize === record.lastInlineSize) {
          continue;
        }
        record.lastInlineSize = inlineSize;
        dirty.add(record.table);
      }
      if (dirty.size > 0) {
        flushTableEdgeUpdates(dirty);
      }
    });
  }
  observedElements.set(element, { lastInlineSize: undefined, table });
  sharedResizeObserver.observe(element);
  return () => {
    observedElements.delete(element);
    sharedResizeObserver?.unobserve(element);
    if (observedElements.size === 0) {
      sharedResizeObserver?.disconnect();
      sharedResizeObserver = undefined;
    }
  };
}

function applyBooleanAttribute(
  element: HTMLElement,
  name: string,
  visible: boolean,
): void {
  if (visible) {
    if (element.getAttribute(name) !== "true") {
      element.setAttribute(name, "true");
    }
  } else if (element.hasAttribute(name)) {
    element.removeAttribute(name);
  }
}

// ---------------------------------------------------------------------------
// Shared vertical-scroll-ancestor sticky header coordinator
// ---------------------------------------------------------------------------
// A horizontal scroll container (`overflow-x: auto`) also computes `overflow-y`
// to `auto`, which traps CSS `position: sticky; top: 0` inside the horizontal
// wrapper rather than sticking to the outer transcript or document scroller.
// Tracking visible tables per vertical scroll ancestor with one passive scroll
// listener + IntersectionObserver keeps headers pinned in O(visible tables)
// per scroll frame with zero React re-renders.

type StickyRegistration = {
  scroller: HTMLDivElement;
  wrap: HTMLDivElement;
};

type ScrollAncestorCoordinator = {
  allTables: Set<StickyRegistration>;
  intersectionObserver?: IntersectionObserver;
  resizeObserver?: ResizeObserver;
  scrollAncestor: HTMLElement;
  syncVisible: () => void;
  teardown: () => void;
  visibleTables: Set<StickyRegistration>;
  wrapToRegistration: Map<Element, StickyRegistration>;
};

const scrollAncestorCoordinators = new WeakMap<
  HTMLElement,
  ScrollAncestorCoordinator
>();

// Matches `--transcript-pin-step: 28px` in app.css for expanded pinned
// work-phase/activity headers inside `.transcript-list__items`.
const TRANSCRIPT_PIN_STEP_PX = 28;

function findVerticalScrollAncestor(element: HTMLElement): HTMLElement | null {
  let current = element.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    const style = window.getComputedStyle(current);
    const overflowY = style.overflowY;
    if (overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function measureStickyAncestorInset(
  wrap: HTMLElement,
  scrollAncestor: HTMLElement,
): number {
  if (!scrollAncestor.classList.contains("transcript-list__items")) {
    return 0;
  }
  let inset = 0;
  let current = wrap.parentElement;
  while (current && current !== scrollAncestor) {
    if (current.getAttribute("data-expanded") === "true") {
      if (
        current.classList.contains("transcript-work-phase-group")
        || (
          current.classList.contains("transcript-activity")
          && !current.classList.contains("transcript-activity--warning")
        )
        || current.classList.contains("transcript-activity__detail")
      ) {
        inset += TRANSCRIPT_PIN_STEP_PX;
      }
    }
    current = current.parentElement;
  }
  return inset;
}

function applyStickyHeaderState(
  wrap: HTMLDivElement,
  state: StickyHeaderState,
): void {
  applyBooleanAttribute(wrap, "data-sticky-header", state.active);
  if (state.active) {
    const value = `${state.offsetY}px`;
    if (wrap.style.getPropertyValue("--table-sticky-y") !== value) {
      wrap.style.setProperty("--table-sticky-y", value);
    }
  } else if (wrap.style.getPropertyValue("--table-sticky-y")) {
    wrap.style.removeProperty("--table-sticky-y");
  }
}

function getOrCreateScrollAncestorCoordinator(
  scrollAncestor: HTMLElement,
): ScrollAncestorCoordinator {
  const existing = scrollAncestorCoordinators.get(scrollAncestor);
  if (existing) {
    return existing;
  }

  const allTables = new Set<StickyRegistration>();
  const visibleTables = new Set<StickyRegistration>();
  const wrapToRegistration = new Map<Element, StickyRegistration>();

  const syncVisible = (): void => {
    const targets = visibleTables.size > 0
      ? visibleTables
      : typeof IntersectionObserver === "undefined"
        ? allTables
        : visibleTables;
    if (targets.size === 0) {
      return;
    }

    // Phase 1: batch all DOM geometry reads together (no interleaved writes).
    const ancestorRect = scrollAncestor.getBoundingClientRect();
    const pending: Array<{ state: StickyHeaderState; wrap: HTMLDivElement }> = [];
    for (const registration of targets) {
      const table = registration.scroller.firstElementChild;
      if (!(table instanceof HTMLTableElement) || !table.tHead) {
        pending.push({
          state: { active: false, offsetY: 0 },
          wrap: registration.wrap,
        });
        continue;
      }
      const tableRect = table.getBoundingClientRect();
      const headRect = table.tHead.getBoundingClientRect();
      const stickyTopInset = measureStickyAncestorInset(
        registration.wrap,
        scrollAncestor,
      );
      pending.push({
        state: computeStickyHeaderState({
          headerHeight: headRect.height,
          stickyTopInset,
          tableBottom: tableRect.bottom,
          tableTop: tableRect.top,
          viewportBottom: ancestorRect.bottom,
          viewportTop: ancestorRect.top,
        }),
        wrap: registration.wrap,
      });
    }

    // Phase 2: apply changed attributes and CSS variables only.
    for (const { state, wrap } of pending) {
      applyStickyHeaderState(wrap, state);
    }
  };

  let intersectionObserver: IntersectionObserver | undefined;
  if (typeof IntersectionObserver !== "undefined") {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        let shouldSync = false;
        for (const entry of entries) {
          const registration = wrapToRegistration.get(entry.target);
          if (!registration) {
            continue;
          }
          if (entry.isIntersecting) {
            visibleTables.add(registration);
            shouldSync = true;
          } else {
            visibleTables.delete(registration);
            applyStickyHeaderState(registration.wrap, { active: false, offsetY: 0 });
          }
        }
        if (shouldSync) {
          syncVisible();
        }
      },
      { root: scrollAncestor, rootMargin: "120px 0px" },
    );
  }

  let resizeObserver: ResizeObserver | undefined;
  if (typeof ResizeObserver !== "undefined") {
    resizeObserver = new ResizeObserver(() => {
      syncVisible();
    });
    resizeObserver.observe(scrollAncestor);
  }

  scrollAncestor.addEventListener("scroll", syncVisible, { passive: true });

  const teardown = (): void => {
    scrollAncestor.removeEventListener("scroll", syncVisible);
    intersectionObserver?.disconnect();
    resizeObserver?.disconnect();
    scrollAncestorCoordinators.delete(scrollAncestor);
  };

  const coordinator: ScrollAncestorCoordinator = {
    allTables,
    intersectionObserver,
    resizeObserver,
    scrollAncestor,
    syncVisible,
    teardown,
    visibleTables,
    wrapToRegistration,
  };
  scrollAncestorCoordinators.set(scrollAncestor, coordinator);
  return coordinator;
}

function registerStickyTable(
  wrap: HTMLDivElement,
  scroller: HTMLDivElement,
): () => void {
  const scrollAncestor = findVerticalScrollAncestor(wrap);
  if (!scrollAncestor) {
    applyStickyHeaderState(wrap, { active: false, offsetY: 0 });
    return () => {};
  }

  const coordinator = getOrCreateScrollAncestorCoordinator(scrollAncestor);
  const registration: StickyRegistration = { scroller, wrap };
  coordinator.allTables.add(registration);
  coordinator.wrapToRegistration.set(wrap, registration);
  if (coordinator.intersectionObserver) {
    coordinator.intersectionObserver.observe(wrap);
  } else {
    coordinator.visibleTables.add(registration);
  }
  coordinator.syncVisible();

  return () => {
    applyStickyHeaderState(wrap, { active: false, offsetY: 0 });
    coordinator.allTables.delete(registration);
    coordinator.visibleTables.delete(registration);
    coordinator.wrapToRegistration.delete(wrap);
    coordinator.intersectionObserver?.unobserve(wrap);
    if (coordinator.allTables.size === 0) {
      coordinator.teardown();
    }
  };
}

export function TableScrollContainer(props: {
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  onExpand?: (context: TableExpandContext) => void;
  onPinnedFirstColumnChange?: (pinned: boolean) => void;
  pinRecommendation?: PinFirstColumnRecommendation;
  pinnedFirstColumn?: boolean;
  role?: string;
  showToolbar?: boolean;
  stickyHeader?: TableStickyMode;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinRecommendation = props.pinRecommendation ?? "none";
  const canPin = canOfferColumnPin(pinRecommendation);
  const stickyMode: TableStickyMode = props.stickyHeader ?? "scroll-ancestor";

  const [uncontrolledPinOverride, setUncontrolledPinOverride] = useState<
    boolean | undefined
  >(undefined);
  const desiredPinned = props.pinnedFirstColumn !== undefined
    ? props.pinnedFirstColumn
    : uncontrolledPinOverride !== undefined
      ? uncontrolledPinOverride
      : pinRecommendation === "auto";

  const observedRef = useRef<ObservedTable | undefined>(undefined);

  const syncScrollEdges = useCallback(() => {
    const observed = observedRef.current;
    if (observed) {
      flushTableEdgeUpdates([observed]);
      return;
    }
    const wrap = wrapRef.current;
    const scroller = scrollRef.current;
    if (!wrap || !scroller) {
      return;
    }
    flushTableEdgeUpdates([{ canPin, desiredPinned, scroller, wrap }]);
  }, [canPin, desiredPinned]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef.current;
    if (!wrap || !scroller) {
      return;
    }
    const observed: ObservedTable = { canPin, desiredPinned, scroller, wrap };
    observedRef.current = observed;
    flushTableEdgeUpdates([observed]);
    const cleanups = [observeTableElement(scroller, observed)];
    const table = scroller.firstElementChild;
    if (table) {
      cleanups.push(observeTableElement(table, observed));
    }
    return () => {
      observedRef.current = undefined;
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
    // Keep observer subscriptions bound to the mounted DOM nodes; pin-state
    // toggles update the existing record in the effect below without recreating
    // ResizeObserver subscriptions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const observed = observedRef.current;
    if (!observed) {
      return;
    }
    observed.canPin = canPin;
    observed.desiredPinned = desiredPinned;
    flushTableEdgeUpdates([observed]);
  }, [canPin, desiredPinned]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef.current;
    if (!wrap || !scroller || stickyMode !== "scroll-ancestor") {
      if (wrap) {
        applyStickyHeaderState(wrap, { active: false, offsetY: 0 });
      }
      return undefined;
    }
    return registerStickyTable(wrap, scroller);
  }, [stickyMode]);

  const togglePin = useCallback(() => {
    const nextPinned = !desiredPinned;
    if (props.pinnedFirstColumn === undefined) {
      setUncontrolledPinOverride(nextPinned);
    }
    props.onPinnedFirstColumnChange?.(nextPinned);
  }, [desiredPinned, props.onPinnedFirstColumnChange, props.pinnedFirstColumn]);

  const handleExpand = useCallback(() => {
    if (!props.onExpand) {
      return;
    }
    const tableElement = scrollRef.current?.firstElementChild instanceof HTMLTableElement
      ? scrollRef.current.firstElementChild
      : null;
    props.onExpand({
      pinnedFirstColumn: desiredPinned,
      tableElement,
    });
  }, [desiredPinned, props.onExpand]);

  const showToolbar =
    props.showToolbar !== false && (canPin || Boolean(props.onExpand));

  return (
    <div
      ref={wrapRef}
      className={[
        "thread-markdown__table-wrap",
        stickyMode === "native" ? "thread-markdown__table-wrap--native-sticky" : undefined,
        props.className,
      ]
        .filter(Boolean)
        .join(" ")}
      data-sticky-mode={stickyMode}
    >
      <div
        ref={scrollRef}
        className="thread-markdown__table-scroll"
        role={props.role}
        aria-label={props.ariaLabel}
        tabIndex={0}
        onScroll={syncScrollEdges}
      >
        {props.children}
      </div>
      {showToolbar ? (
        <div className="thread-markdown__table-actions">
          {canPin ? (
            <button
              type="button"
              className="thread-markdown__table-action thread-markdown__table-action--pin tooltip-target"
              aria-label={desiredPinned ? "Unpin first column" : "Pin first column"}
              aria-pressed={desiredPinned}
              data-tooltip={desiredPinned ? "Unpin first column" : "Pin first column"}
              onClick={togglePin}
            >
              <PinIcon size={13} aria-hidden="true" />
            </button>
          ) : null}
          {props.onExpand ? (
            <button
              type="button"
              className="thread-markdown__table-action thread-markdown__table-action--expand tooltip-target"
              aria-label="Open table viewer"
              data-tooltip="Open table viewer"
              onClick={handleExpand}
            >
              <ExpandIcon size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
