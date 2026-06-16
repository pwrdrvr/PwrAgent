// Renderer-local signal shared between the App sidebar-resize drag handler and
// the transcript's scroll/resize sync. While the left sidebar is being actively
// dragged, every pointer frame changes `--sidebar-width`, which resizes the main
// pane and reflows the (un-virtualized) transcript. The transcript's
// ResizeObserver/onScroll handlers normally respond by reading layout
// (scrollHeight/clientHeight) and writing scrollTop + calling setState — a
// read→write→read layout thrash plus a full re-render, once per frame.
//
// During an active drag we pause that re-sync (see TranscriptList) so the drag
// pays only the unavoidable single reflow per frame, not the amplified thrash.
// The transcript re-syncs once when the drag ends.
//
// Per-window by construction: each renderer window is its own module instance.

type Listener = (active: boolean) => void;

let active = false;
const listeners = new Set<Listener>();

export function isSidebarResizing(): boolean {
  return active;
}

export function setSidebarResizing(next: boolean): void {
  if (active === next) {
    return;
  }
  active = next;
  for (const listener of listeners) {
    listener(active);
  }
}

/** Subscribe to drag start/stop transitions. Returns an unsubscribe fn. */
export function subscribeSidebarResizing(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
