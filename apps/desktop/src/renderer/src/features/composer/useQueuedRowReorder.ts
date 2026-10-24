import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { flushSync } from "react-dom";

/**
 * One queued row as the reorder sees it. Rows that share a `group` and sit
 * next to each other form a run, and a row moves only within its run: a held,
 * steering or scheduled row has no group and is a wall nothing passes.
 */
export type QueuedReorderRow = {
  id: string;
  group?: string;
  title: string;
  /** Paused rows move like any other but take no place in the send order. */
  paused?: boolean;
};

export const QUEUED_ROW_DRAG_ACTIVATION_PX = 4;
const POST_DRAG_CLICK_SUPPRESS_MS = 150;
const SETTLE_MS = 140;
const LANDED_MS = 700;
const EDGE_SCROLL_ZONE_PX = 24;
const EDGE_SCROLL_MAX_PX = 8;

/** Labels a plain queued row by its place in the band. */
export function queuedPositionLabel(index: number): string {
  return index === 0 ? "Next" : `#${index + 1}`;
}

/** The first and last index of the run of movable rows that holds `index`. */
export function queuedReorderRun(
  rows: readonly QueuedReorderRow[],
  index: number,
): [number, number] | undefined {
  const group = rows[index]?.group;
  if (!group) return undefined;
  let lo = index;
  let hi = index;
  while (lo > 0 && rows[lo - 1]?.group === group) lo -= 1;
  while (hi < rows.length - 1 && rows[hi + 1]?.group === group) hi += 1;
  return [lo, hi];
}

/** Rows that do not carry their own drag or keys. */
const NON_DRAG_TARGETS = [
  ".composer__queued-actions",
  ".composer__queued-detail",
  ".queued-message-inspector",
].join(", ");

type Rect = { top: number; height: number };

type DragSession = {
  id: string;
  index: number;
  pointerId: number;
  startClientY: number;
  active: boolean;
  signature: string;
  container?: HTMLElement;
  containerTop?: number;
  containerHeight?: number;
  startScrollTop?: number;
  rows?: HTMLElement[];
  rects?: Rect[];
  lo?: number;
  hi?: number;
  gap?: number;
  slot?: HTMLDivElement;
  target?: number;
  settleDy?: number;
  clientY: number;
  frame?: number;
  cleanup: () => void;
};

export type QueuedRowReorder = {
  canMove: (id: string) => boolean;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>, id: string) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLElement>, id: string) => void;
  /** The polite live region the hook writes move announcements into. */
  announcerRef: (element: HTMLElement | null) => void;
  subscribe: (listener: () => void) => () => void;
  /**
   * A row's place in the send order — among the rows that are not paused —
   * in the order the drag in progress would make, or the band's order.
   */
  previewPlace: (id: string) => number | undefined;
  /** Drops a drag in progress without moving anything. */
  cancel: () => void;
};

/**
 * Drag and keyboard reordering for the queued rows above a composer.
 *
 * Like pinned threads, this is a pointer session rather than native HTML
 * drag-and-drop, which suppresses ordinary input events in Chromium. The
 * session moves rows with transforms only, outside React: the rows under the
 * lifted one slide to open a slot the size of the lifted row, so the gap is
 * where the drop lands. React renders again when a drop commits through
 * `onMove`, and when the drop target changes, through `previewPlace`, so the
 * position labels read the order the drop would make.
 */
export function useQueuedRowReorder(params: {
  rows: readonly QueuedReorderRow[];
  onMove: (id: string, toIndex: number) => void;
}): QueuedRowReorder {
  const latest = useRef(params);
  latest.current = params;
  const sessionRef = useRef<DragSession | undefined>(undefined);
  const announcerRef = useRef<HTMLElement | null>(null);
  const previewRef = useRef<Map<string, number> | undefined>(undefined);
  const listenersRef = useRef(new Set<() => void>());
  const signature = params.rows.map((row) => `${row.id}:${row.group ?? ""}`).join("\n");

  const reorder = useMemo<QueuedRowReorder>(() => {
    const notify = (): void => {
      for (const listener of listenersRef.current) listener();
    };
    const setPreview = (preview: Map<string, number> | undefined): void => {
      previewRef.current = preview;
      notify();
    };
    const announce = (message: string): void => {
      const region = announcerRef.current;
      if (!region) return;
      // Clear first so a repeat of the same sentence is read again.
      region.textContent = "";
      window.setTimeout(() => {
        if (announcerRef.current === region) region.textContent = message;
      }, 30);
    };
    const announceMove = (row: QueuedReorderRow, to: number): void => {
      const count = latest.current.rows.length;
      announce(`Moved “${row.title}” to ${to === 0 ? "Next" : `position ${to + 1}`} of ${count}.`);
    };
    const reducedMotion = (): boolean =>
      typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const markLanded = (container: HTMLElement | undefined, id: string): void => {
      const row = container?.querySelector<HTMLElement>(
        `[data-queued-reorder-id="${CSS.escape(id)}"]`,
      );
      if (!row) return;
      row.classList.add("is-reorder-landed");
      window.setTimeout(() => row.classList.remove("is-reorder-landed"), LANDED_MS);
    };
    const commit = (id: string, to: number): void => {
      const rows = latest.current.rows;
      const from = rows.findIndex((row) => row.id === id);
      const row = rows[from];
      if (!row || from === to) return;
      flushSync(() => latest.current.onMove(id, to));
      announceMove(row, to);
    };

    const contentY = (session: DragSession, clientY: number): number =>
      clientY - session.containerTop! + session.container!.scrollTop;

    const place = (session: DragSession): void => {
      const rects = session.rects!;
      const rows = session.rows!;
      const { index } = session;
      const lo = session.lo!;
      const hi = session.hi!;
      const lifted = rects[index]!;
      const span = lifted.height + session.gap!;
      const startY = session.startClientY - session.containerTop! + session.startScrollTop!;
      const dy = contentY(session, session.clientY) - startY;
      const minDy = rects[lo]!.top - lifted.top;
      const maxDy = rects[hi]!.top + rects[hi]!.height - (lifted.top + lifted.height);
      const clamped = Math.max(minDy, Math.min(maxDy, dy));
      const center = lifted.top + clamped + lifted.height / 2;
      // At a clamp the lifted row's center sits exactly on the end row's
      // center; that still counts as reaching it.
      let target = index;
      for (let i = lo; i < index; i += 1) {
        if (center <= rects[i]!.top + rects[i]!.height / 2) { target = i; break; }
      }
      for (let i = hi; i > index; i -= 1) {
        if (center >= rects[i]!.top + rects[i]!.height / 2) { target = i; break; }
      }
      rows[index]!.style.transform = `translateY(${clamped}px)`;
      rows.forEach((row, i) => {
        if (i === index) return;
        const shift = target < index && i >= target && i < index
          ? span
          : target > index && i > index && i <= target
            ? -span
            : 0;
        row.style.transform = shift ? `translateY(${shift}px)` : "";
      });
      const slotTop = target <= index
        ? rects[target]!.top
        : rects[target]!.top + rects[target]!.height - lifted.height;
      session.slot!.style.top = `${slotTop}px`;
      session.slot!.style.height = `${lifted.height}px`;
      session.settleDy = slotTop - lifted.top;
      if (session.target !== target) {
        session.target = target;
        const order = latest.current.rows.map((row) => row.id);
        order.splice(target, 0, ...order.splice(index, 1));
        setPreview(new Map(order.map((id, position) => [id, position])));
      }
    };

    const tick = (session: DragSession): void => {
      session.frame = undefined;
      if (sessionRef.current !== session || !session.active) return;
      const container = session.container!;
      const top = session.containerTop!;
      const bottom = top + session.containerHeight!;
      const toTop = session.clientY - top;
      const toBottom = bottom - session.clientY;
      let scroll = 0;
      if (toTop < EDGE_SCROLL_ZONE_PX && container.scrollTop > 0) {
        scroll = -Math.ceil(EDGE_SCROLL_MAX_PX * (1 - Math.max(0, toTop) / EDGE_SCROLL_ZONE_PX));
      } else if (
        toBottom < EDGE_SCROLL_ZONE_PX
        && container.scrollTop + container.clientHeight < container.scrollHeight
      ) {
        scroll = Math.ceil(EDGE_SCROLL_MAX_PX * (1 - Math.max(0, toBottom) / EDGE_SCROLL_ZONE_PX));
      }
      if (scroll) container.scrollTop += scroll;
      place(session);
      // Keep scrolling while the pointer rests in an edge zone.
      if (scroll) schedule(session);
    };
    function schedule(session: DragSession): void {
      if (session.frame !== undefined) return;
      // Claimed before the request, so a frame that runs at once still
      // leaves the next pointer move free to schedule another.
      session.frame = -1;
      const frame = window.requestAnimationFrame(() => tick(session));
      if (session.frame === -1) session.frame = frame;
    }

    const activate = (session: DragSession, source: HTMLElement): boolean => {
      const container = source.parentElement;
      if (!container) return false;
      const rows = [...container.children].filter(
        (child): child is HTMLElement =>
          child instanceof HTMLElement && child.dataset.queuedReorderId !== undefined,
      );
      const ids = latest.current.rows.map((row) => row.id);
      if (rows.length !== ids.length || rows.some((row, i) => row.dataset.queuedReorderId !== ids[i])) {
        return false;
      }
      const run = queuedReorderRun(latest.current.rows, session.index);
      if (!run) return false;
      const box = container.getBoundingClientRect();
      const rects = rows.map((row) => {
        const rect = row.getBoundingClientRect();
        return { top: rect.top - box.top + container.scrollTop, height: rect.height };
      });
      const gap = rects.length > 1
        ? Math.max(0, rects[1]!.top - (rects[0]!.top + rects[0]!.height))
        : Number.parseFloat(getComputedStyle(container).rowGap) || 0;
      const sourceBox = source.getBoundingClientRect();
      const slot = document.createElement("div");
      slot.className = "composer__queued-slot";
      slot.setAttribute("aria-hidden", "true");
      slot.style.left = `${sourceBox.left - box.left - container.clientLeft}px`;
      slot.style.width = `${sourceBox.width}px`;
      container.appendChild(slot);
      Object.assign(session, {
        active: true,
        container,
        containerTop: box.top,
        containerHeight: box.height,
        startScrollTop: container.scrollTop,
        rows,
        rects,
        lo: run[0],
        hi: run[1],
        gap,
        slot,
      });
      container.classList.add("is-queued-reordering");
      rows[session.index]!.classList.add("is-reorder-lifted");
      rows.forEach((row, i) => {
        if (i !== session.index) row.classList.add("is-reorder-sliding");
      });
      return true;
    };

    const teardown = (session: DragSession): void => {
      if (session.frame !== undefined && session.frame >= 0) {
        window.cancelAnimationFrame(session.frame);
      }
      session.frame = undefined;
      session.slot?.remove();
      session.container?.classList.remove("is-queued-reordering");
      for (const row of session.rows ?? []) {
        row.classList.remove("is-reorder-lifted", "is-reorder-sliding", "is-reorder-settling");
        row.style.transform = "";
      }
      setPreview(undefined);
    };

    const finish = (session: DragSession, cancel: boolean): void => {
      if (sessionRef.current !== session) return;
      session.cleanup();
      if (!session.active) {
        sessionRef.current = undefined;
        return;
      }
      const container = session.container!;
      // The release would otherwise click whatever is under the pointer —
      // the chevron, an image chip — and open it.
      const suppress = (event: MouseEvent): void => {
        event.preventDefault();
        event.stopImmediatePropagation();
        container.removeEventListener("click", suppress, true);
      };
      container.addEventListener("click", suppress, true);
      window.setTimeout(
        () => container.removeEventListener("click", suppress, true),
        POST_DRAG_CLICK_SUPPRESS_MS,
      );
      const target = session.target ?? session.index;
      const moved = !cancel && target !== session.index;
      const lifted = session.rows![session.index]!;
      const done = (): void => {
        if (sessionRef.current !== session) return;
        sessionRef.current = undefined;
        teardown(session);
        if (moved) {
          commit(session.id, target);
          markLanded(container, session.id);
        } else if (cancel) {
          announce("Reorder cancelled.");
        }
      };
      if (reducedMotion()) {
        done();
        return;
      }
      lifted.classList.add("is-reorder-settling");
      lifted.style.transform = moved ? `translateY(${session.settleDy ?? 0}px)` : "";
      if (!moved) {
        for (const row of session.rows!) row.style.transform = "";
      }
      window.setTimeout(done, SETTLE_MS);
    };

    return {
      canMove: (id) => {
        const rows = latest.current.rows;
        const run = queuedReorderRun(rows, rows.findIndex((row) => row.id === id));
        return Boolean(run && run[0] !== run[1]);
      },
      cancel: () => {
        const session = sessionRef.current;
        if (!session) return;
        session.cleanup();
        sessionRef.current = undefined;
        if (session.active) teardown(session);
      },
      onPointerDown: (event, id) => {
        if (event.button !== 0 || sessionRef.current) return;
        if (!(event.target instanceof Element) || event.target.closest(NON_DRAG_TARGETS)) return;
        const index = latest.current.rows.findIndex((row) => row.id === id);
        const run = queuedReorderRun(latest.current.rows, index);
        if (!run || run[0] === run[1]) return;
        const source = event.currentTarget;
        const session: DragSession = {
          id,
          index,
          pointerId: event.pointerId,
          startClientY: event.clientY,
          clientY: event.clientY,
          active: false,
          signature: latest.current.rows.map((row) => `${row.id}:${row.group ?? ""}`).join("\n"),
          cleanup: () => {},
        };
        const onMove = (move: PointerEvent): void => {
          if (move.pointerId !== session.pointerId) return;
          session.clientY = move.clientY;
          if (!session.active) {
            if (Math.abs(move.clientY - session.startClientY) < QUEUED_ROW_DRAG_ACTIVATION_PX) return;
            if (!activate(session, source)) {
              finish(session, true);
              return;
            }
            window.getSelection()?.removeAllRanges();
          }
          move.preventDefault();
          schedule(session);
        };
        const onUp = (up: PointerEvent): void => {
          if (up.pointerId === session.pointerId) finish(session, false);
        };
        const onCancel = (cancel: PointerEvent): void => {
          if (cancel.pointerId === session.pointerId) finish(session, true);
        };
        const onKey = (key: KeyboardEvent): void => {
          if (key.key !== "Escape" || !session.active) return;
          // Claimed: a dialog or layer behind the band must not also close.
          key.preventDefault();
          key.stopImmediatePropagation();
          finish(session, true);
        };
        const onBlur = (): void => finish(session, true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("blur", onBlur);
        session.cleanup = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
          window.removeEventListener("pointercancel", onCancel);
          window.removeEventListener("keydown", onKey, true);
          window.removeEventListener("blur", onBlur);
        };
        sessionRef.current = session;
      },
      onKeyDown: (event, id) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        const onGrip = event.target instanceof Element
          && event.target.closest("[data-queued-reorder-grip]") !== null;
        const chord = (event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey;
        const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        if (!chord && !(onGrip && plain)) return;
        const rows = latest.current.rows;
        const index = rows.findIndex((row) => row.id === id);
        const run = queuedReorderRun(rows, index);
        if (!run || sessionRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        const to = Math.max(run[0], Math.min(run[1], index + (event.key === "ArrowUp" ? -1 : 1)));
        if (to === index) {
          announce(to === run[0]
            ? "Already first of the messages that can move."
            : "Already last of the messages that can move.");
          return;
        }
        const focused = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
        const container = event.currentTarget.parentElement ?? undefined;
        commit(id, to);
        // React moves the row's node, and a moved node can drop focus.
        if (focused && document.activeElement !== focused && focused.isConnected) {
          focused.focus({ preventScroll: true });
        }
        focused?.scrollIntoView?.({ block: "nearest" });
        markLanded(container, id);
      },
      announcerRef: (element) => {
        announcerRef.current = element;
      },
      subscribe: (listener) => {
        listenersRef.current.add(listener);
        return () => listenersRef.current.delete(listener);
      },
      previewPlace: (id) => {
        const rows = latest.current.rows;
        const preview = previewRef.current;
        const at = (row: QueuedReorderRow, index: number): number =>
          preview?.get(row.id) ?? index;
        const index = rows.findIndex((row) => row.id === id);
        const row = rows[index];
        if (!row) return undefined;
        const position = at(row, index);
        return rows.filter((other, otherIndex) =>
          !other.paused && at(other, otherIndex) < position
        ).length;
      },
    };
  }, []);

  // The queue changed under the drag (a row started, or another window
  // moved one): the measured rows no longer describe the band.
  useEffect(() => {
    if (sessionRef.current && sessionRef.current.signature !== signature) reorder.cancel();
  }, [reorder, signature]);

  useEffect(() => () => reorder.cancel(), [reorder]);

  return reorder;
}

/**
 * A row's place among the rows that will send, renumbered live while another
 * row is dragged; see `previewPlace`. `index` stands in until the row is
 * known to the reorder.
 */
export function useQueuedPreviewPlace(
  reorder: QueuedRowReorder,
  id: string,
  index: number,
): number {
  return useSyncExternalStore(
    reorder.subscribe,
    () => reorder.previewPlace(id) ?? index,
    () => index,
  );
}
