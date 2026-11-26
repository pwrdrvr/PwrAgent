import {
  useCallback,
  useLayoutEffect,
  useRef,
  type ReactNode,
} from "react";

export type HorizontalScrollEdges = {
  left: boolean;
  right: boolean;
};

// 1px tolerance absorbs sub-pixel rounding at fractional display scales so a
// table that fits or reaches its scroll end does not leave a stray edge fade.
const SCROLL_EDGE_TOLERANCE_PX = 1;

export function computeHorizontalScrollEdges(metrics: {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}): HorizontalScrollEdges {
  if (
    !Number.isFinite(metrics.clientWidth)
    || !Number.isFinite(metrics.scrollLeft)
    || !Number.isFinite(metrics.scrollWidth)
  ) {
    return { left: false, right: false };
  }
  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  if (maxScrollLeft <= SCROLL_EDGE_TOLERANCE_PX) {
    return { left: false, right: false };
  }
  return {
    left: metrics.scrollLeft > SCROLL_EDGE_TOLERANCE_PX,
    right: metrics.scrollLeft < maxScrollLeft - SCROLL_EDGE_TOLERANCE_PX,
  };
}

type ObservedTable = {
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

function flushTableEdgeUpdates(tables: Iterable<ObservedTable>): void {
  // Two-phase read-then-write avoids O(K^2) interleaved forced layouts when
  // multiple tables resize in a single ResizeObserver batch.
  const updates: Array<{ edges: HorizontalScrollEdges; wrap: HTMLDivElement }> = [];
  for (const { scroller, wrap } of tables) {
    updates.push({
      edges: computeHorizontalScrollEdges({
        clientWidth: scroller.clientWidth,
        scrollLeft: scroller.scrollLeft,
        scrollWidth: scroller.scrollWidth,
      }),
      wrap,
    });
  }
  for (const { edges, wrap } of updates) {
    applyEdgeAttribute(wrap, "data-scroll-left", edges.left);
    applyEdgeAttribute(wrap, "data-scroll-right", edges.right);
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

function applyEdgeAttribute(
  element: HTMLElement,
  name: "data-scroll-left" | "data-scroll-right",
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

export function TableScrollContainer(props: {
  ariaLabel?: string;
  children: ReactNode;
  className?: string;
  role?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const syncScrollEdges = useCallback(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef.current;
    if (!wrap || !scroller) {
      return;
    }
    flushTableEdgeUpdates([{ scroller, wrap }]);
  }, []);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    const scroller = scrollRef.current;
    if (!wrap || !scroller) {
      return;
    }
    const observed: ObservedTable = { scroller, wrap };
    flushTableEdgeUpdates([observed]);
    const cleanups = [observeTableElement(scroller, observed)];
    const table = scroller.firstElementChild;
    if (table) {
      cleanups.push(observeTableElement(table, observed));
    }
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className={[
        "thread-markdown__table-wrap",
        props.className,
      ]
        .filter(Boolean)
        .join(" ")}
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
    </div>
  );
}
