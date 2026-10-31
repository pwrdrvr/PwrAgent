/**
 * Observe the anchor's owned DOM path, not streaming siblings' subtrees.
 * IntersectionObserver supplies post-layout rectangles for movement caused by
 * sibling layout, stylesheets and transforms; ResizeObserver covers its size.
 * DOM invalidations coalesce into one cancellable geometry check per frame.
 */
export function observeTooltipAnchor(
  target: HTMLElement,
  baseline: { top: number; right: number; bottom: number; left: number },
  tooltip: () => HTMLElement | null,
  check: (rect?: DOMRectReadOnly) => void,
): () => void {
  let disposed = false;
  let frame: number | undefined;
  const schedule = (): void => {
    if (disposed || frame !== undefined) return;
    if (!target.isConnected) {
      check();
      return;
    }
    frame = window.requestAnimationFrame(() => {
      frame = undefined;
      if (!disposed) check();
    });
  };
  const mutations = new MutationObserver((records) => {
    if (disposed) return;
    if (!target.isConnected) {
      check();
      return;
    }
    const portal = tooltip();
    const relevant = records.some((record) => {
      if (portal?.contains(record.target)) return false;
      if (record.type !== "childList" || !portal) return true;
      return [...record.addedNodes, ...record.removedNodes]
        .some((node) => node !== portal);
    });
    if (relevant) schedule();
  });
  mutations.observe(target, {
    attributes: true, characterData: true, childList: true, subtree: true,
  });
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    mutations.observe(parent, { attributes: true, childList: true });
  }
  const resize = typeof ResizeObserver === "undefined"
    ? undefined
    : new ResizeObserver(schedule);
  resize?.observe(target);

  let intersection: IntersectionObserver | undefined;
  if (typeof IntersectionObserver !== "undefined"
    && baseline.right > baseline.left && baseline.bottom > baseline.top) {
    const root = document.documentElement;
    // Tighten the viewport to the remembered anchor rectangle. Crossing any
    // edge changes the intersection even when the anchor's size is unchanged.
    const rootMargin = `${-baseline.top}px ${baseline.right - root.clientWidth}px ${baseline.bottom - root.clientHeight}px ${-baseline.left}px`;
    let initial = true;
    const observe = (threshold: number): void => {
      const thresholds = threshold === 1 ? [0, 1] : [0,
        Math.max(0, threshold - 0.000001),
        Math.min(1, threshold + 0.000001), 1];
      intersection = new IntersectionObserver((entries) => {
        if (disposed) return;
        const entry = entries.find((entry) => entry.target === target);
        if (!entry) return;
        check(entry.boundingClientRect);
        // A clipped anchor can start below 100% intersection. Watch its actual
        // ratio as well so a further move still delivers a notification.
        if (initial) {
          initial = false;
          if (entry.intersectionRatio > 0 && entry.intersectionRatio < 1) {
            intersection?.disconnect();
            observe(entry.intersectionRatio);
          }
        }
      }, { rootMargin, threshold: thresholds });
      intersection.observe(target);
    };
    observe(1);
  }
  return () => {
    disposed = true;
    mutations.disconnect();
    resize?.disconnect();
    intersection?.disconnect();
    if (frame !== undefined) window.cancelAnimationFrame(frame);
  };
}
