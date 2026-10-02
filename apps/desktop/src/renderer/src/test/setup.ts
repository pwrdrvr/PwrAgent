import { act, configure, fireEvent } from "@testing-library/react";

/**
 * A durable notice card is drawn over hidden copies of its kind's other
 * notices, which only lend it their size (AppNoticeStack.tsx). They are
 * aria-hidden, so role queries already skip them; text queries would find
 * every page of the card at once.
 */
configure({ defaultIgnore: "script, style, .app-notice-toast--sizer *" });

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

// Tiptap's controlled input updates React state when fireEvent.change assigns
// target.value, before Testing Library wraps the DOM event in act. Wrap the
// entire helper so the assignment and the event share the same act scope.
const change = fireEvent.change;
fireEvent.change = (...args: Parameters<typeof change>) => {
  let dispatched = false;
  act(() => {
    dispatched = change(...args);
  });
  return dispatched;
};
