import { afterEach } from "vitest";

/**
 * jsdom implements `getClientRects` on Element but not on Range, and
 * ProseMirror asks a Range for its rects whenever it scrolls a selection
 * into view — which `editor.commands.focus()` does by default.
 *
 * Synchronous tests never notice: the composer schedules its post-insert
 * focus in a `requestAnimationFrame`, and teardown destroys the editor
 * before the frame runs. The moment a test awaits anything after inserting
 * a mention chip, that frame fires while the editor is still mounted and
 * the missing method surfaces as an unhandled `TypeError` that fails the
 * whole run rather than any one test.
 *
 * Empty rects are the honest answer here: jsdom does no layout, so there
 * is no geometry to report and ProseMirror's scroll is correctly a no-op.
 */
if (typeof Range.prototype.getClientRects !== "function") {
  Range.prototype.getClientRects = function getClientRects() {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
  Range.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return new DOMRect(0, 0, 0, 0);
  };
}

const originalConsoleError = console.error.bind(console);

afterEach(() => {
  // Renderer windows keep reload-only state in sessionStorage. Vitest reuses
  // one jsdom window across files in a worker, so clear that window-scoped
  // state at the test boundary just as closing a real BrowserWindow would.
  window.sessionStorage.clear();
});

console.error = (...args: unknown[]) => {
  // The renderer suite asserts the visible states around these async paths.
  // React's CI-only act warning flood makes GitHub logs unreadable without
  // adding signal for these tests, so keep other errors intact and filter only
  // that exact warning text.
  if (isReactActWarning(args)) {
    return;
  }

  originalConsoleError(...args);
};

function isReactActWarning(args: unknown[]): boolean {
  const [first] = args;
  return (
    typeof first === "string" &&
    first.includes("inside a test was not wrapped in act(...)")
  );
}
