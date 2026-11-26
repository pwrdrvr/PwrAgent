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
  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  if (maxScrollLeft <= SCROLL_EDGE_TOLERANCE_PX) {
    return { left: false, right: false };
  }
  return {
    left: metrics.scrollLeft > SCROLL_EDGE_TOLERANCE_PX,
    right: metrics.scrollLeft < maxScrollLeft - SCROLL_EDGE_TOLERANCE_PX,
  };
}

type ResizeHandler = () => void;

let sharedResizeObserver: ResizeObserver | undefined;
const observedElements = new Map<Element, ResizeHandler>();

function observeTableResize(element: Element, handler: ResizeHandler): () => void {
  if (typeof ResizeObserver === "undefined") {
    return () => {};
  }
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      const invoked = new Set<ResizeHandler>();
      for (const entry of entries) {
        const callback = observedElements.get(entry.target);
        if (callback && !invoked.has(callback)) {
          invoked.add(callback);
          callback();
        }
      }
    });
  }
  observedElements.set(element, handler);
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
    const edges = computeHorizontalScrollEdges({
      clientWidth: scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
    });
    applyEdgeAttribute(wrap, "data-scroll-left", edges.left);
    applyEdgeAttribute(wrap, "data-scroll-right", edges.right);
  }, []);

  useLayoutEffect(() => {
    syncScrollEdges();
    const scroller = scrollRef.current;
    if (!scroller) {
      return;
    }
    const cleanups = [observeTableResize(scroller, syncScrollEdges)];
    const table = scroller.firstElementChild;
    if (table) {
      cleanups.push(observeTableResize(table, syncScrollEdges));
    }
    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    };
  }, [syncScrollEdges]);

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
