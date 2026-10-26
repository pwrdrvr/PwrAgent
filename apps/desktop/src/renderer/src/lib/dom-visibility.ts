type VisibilityScope = {
  values: Map<HTMLElement, boolean>;
  styles: Map<HTMLElement, CSSStyleDeclaration>;
  observer: MutationObserver;
};

let scope: VisibilityScope | undefined;

/** Group synchronous visibility reads; DOM mutations invalidate before a read. */
export function withVisibilityReadScope<T>(read: () => T): T {
  const previous = scope;
  const values = new Map<HTMLElement, boolean>();
  const styles = new Map<HTMLElement, CSSStyleDeclaration>();
  const clear = () => { values.clear(); styles.clear(); };
  const observer = new MutationObserver(clear);
  observer.observe(document.documentElement, {
    subtree: true, childList: true, attributes: true,
    attributeFilter: ["style", "hidden", "open", "type"],
  });
  scope = { values, styles, observer };
  try {
    return read();
  } finally {
    observer.disconnect();
    scope = previous;
  }
}

/** Display/visibility only: transparent controls remain real keyboard stops. */
export function isElementVisible(el: HTMLElement, styles: Map<HTMLElement, CSSStyleDeclaration>): boolean {
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ visibilityProperty: true });
  }
  const current = scope;
  if (current?.observer.takeRecords().length) {
    current.values.clear();
    current.styles.clear();
  }
  // Without author styles, focus alone cannot change display/visibility.
  // Inline and UA visibility changes have DOM attributes. Popovers and shadow
  // styles have separate state/cascades, so they always take the fresh path.
  let cacheable = Boolean(current) && document.styleSheets.length === 0
    && (document.adoptedStyleSheets?.length ?? 0) === 0 && !el.closest("[popover]");
  for (let node: HTMLElement | null = el; cacheable && node; node = node.parentElement) {
    if (node.shadowRoot) cacheable = false;
  }
  const values = cacheable ? current!.values : undefined;
  const reads = cacheable ? current!.styles : styles;
  const cached = values?.get(el);
  if (cached !== undefined) return cached;
  for (let node: HTMLElement | null = el; node; node = node.parentElement) {
    let style = reads.get(node);
    if (!style) {
      style = getComputedStyle(node);
      reads.set(node, style);
    }
    if (style.display === "none" || style.visibility === "hidden") {
      values?.set(el, false);
      return false;
    }
  }
  values?.set(el, true);
  return true;
}
