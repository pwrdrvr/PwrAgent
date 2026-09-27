type VisibilityEntry = { intersecting: boolean; notify: (visible: boolean) => void };
const entries = new Map<Element, VisibilityEntry>();
let observer: IntersectionObserver | undefined;

function publishVisibility(): void {
  for (const entry of entries.values()) {
    entry.notify(entry.intersecting && !document.hidden);
  }
}

/** One observer for all chips, including clipping by the transcript scroller. */
export function observeElementVisibility(
  element: Element,
  notify: (visible: boolean) => void,
): () => void {
  if (!entries.size) {
    document.addEventListener("visibilitychange", publishVisibility);
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver((changes) => {
        for (const change of changes) {
          const entry = entries.get(change.target);
          if (!entry) continue;
          entry.intersecting = change.isIntersecting;
          entry.notify(entry.intersecting && !document.hidden);
        }
      });
    }
  }
  const entry = { intersecting: !observer, notify };
  entries.set(element, entry);
  observer?.observe(element);
  notify(entry.intersecting && !document.hidden);
  return () => {
    observer?.unobserve(element);
    entries.delete(element);
    if (!entries.size) {
      observer?.disconnect();
      observer = undefined;
      document.removeEventListener("visibilitychange", publishVisibility);
    }
  };
}
