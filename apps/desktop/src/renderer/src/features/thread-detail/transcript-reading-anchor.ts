// These boxes follow transcript order vertically. In particular, the sticky
// disclosure controls are excluded, and image tiles on one line share a top.
const INNER_READING_BLOCKS = [
  ".transcript-work-phase-group__content > :is(article, aside)",
  ".transcript-work-phase-group__images > *",
  ".transcript-message__image-grid > *",
  ".transcript-activity__images > *",
  ".transcript-browser-use__preview-button",
].join(", ");
const READING_BLOCK_SELECTOR = `:scope > *, ${INNER_READING_BLOCKS}`;
const IMAGE_LINES = [
  ".transcript-work-phase-group__images",
  ".transcript-message__image-grid",
  ".transcript-activity__images",
].join(", ");

type ReadingAnchor = {
  element: Element;
  // Content coordinates let us distinguish layout movement from user scroll.
  offset: number;
};

// Find the last start at or above the reading line. If that box has ended,
// anchor the next one so a gap above it doesn't select a box out of view.
function readingBlock(
  count: number,
  getBlock: (index: number) => Element,
  line: number,
): Element {
  let low = 0;
  let high = count;
  let previous: { element: Element; bottom: number } | undefined;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const element = getBlock(middle);
    const { top, bottom } = element.getBoundingClientRect();
    if (top <= line) {
      low = middle + 1;
      previous = { element, bottom };
    } else {
      high = middle;
    }
  }
  if (previous && (previous.bottom >= line || low === count)) {
    return previous.element;
  }
  return getBlock(low);
}

export function createTranscriptReadingAnchor() {
  let anchor: ReadingAnchor | undefined;
  let observer: MutationObserver | undefined;
  const rowBlocks = new WeakMap<Element, Element[]>();

  const updateBlocks = (records: MutationRecord[]) => {
    for (const { target, addedNodes, removedNodes, nextSibling } of records) {
      if (!(target instanceof Element)) continue;
      const row = target.closest(".transcript-list__item");
      if (!row) continue;
      const blocks = rowBlocks.get(row);
      if (!blocks) continue;

      // A work phase can keep appending while the reader scrolls through it.
      // Its content ends the row, so index only the newly appended subtree.
      if (target.matches(".transcript-work-phase-group__content")
        && nextSibling === null && removedNodes.length === 0) {
        for (const node of addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches("article, aside")) blocks.push(node);
          for (const block of node.querySelectorAll(INNER_READING_BLOCKS)) blocks.push(block);
        }
        continue;
      }

      // Text streaming inside an existing block doesn't affect the index.
      // A removed node has lost its parent, so use the mutation target to
      // recognize direct children of an image line or work phase.
      if (target === row || target.matches(`${IMAGE_LINES}, .transcript-work-phase-group__content`)) {
        rowBlocks.delete(row);
        continue;
      }
      for (const nodes of [addedNodes, removedNodes]) {
        for (const node of nodes) {
          if (node instanceof Element
            && (node.matches(".transcript-browser-use__preview-button")
              || node.querySelector(INNER_READING_BLOCKS))) {
            rowBlocks.delete(row);
            break;
          }
        }
      }
    }
  };

  return {
    capture(scroller: HTMLElement, rowIds: readonly string[], positionChanged: boolean) {
      if (anchor && !positionChanged) return;
      anchor = undefined;
      if (rowIds.length === 0) return;
      const { top } = scroller.getBoundingClientRect();
      const line = top + Math.min(32, scroller.clientHeight / 2);
      const firstBox = readingBlock(rowIds.length, (index) => {
        const row = scroller.ownerDocument.getElementById(rowIds[index])!;
        return row.firstElementChild ?? row;
      }, line);
      const row = firstBox.closest(".transcript-list__item")!;
      if (observer) updateBlocks(observer.takeRecords());
      let blocks = rowBlocks.get(row);
      if (!blocks) {
        blocks = Array.from(row.querySelectorAll(READING_BLOCK_SELECTOR));
        rowBlocks.set(row, blocks);
      }
      const element = blocks.length > 0
        ? readingBlock(blocks.length, (index) => blocks[index], line)
        : firstBox;
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) {
        anchor = { element, offset: rect.top - top + scroller.scrollTop };
      }
    },

    restore(scroller: HTMLElement, prepending = false): boolean {
      if (!anchor || !scroller.contains(anchor.element)) {
        anchor = undefined;
        return false;
      }
      if (scroller.scrollTop <= 0 && !prepending) {
        anchor = undefined;
        return false;
      }
      const rect = anchor.element.getBoundingClientRect();
      if (rect.height <= 0) {
        anchor = undefined;
        return false;
      }
      const offset = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      const shift = offset - anchor.offset;
      if (Math.abs(shift) >= 1) {
        scroller.scrollTop += shift;
        anchor.offset = offset;
      }
      return true;
    },

    watchBlocks(content: HTMLElement) {
      const subscription = new MutationObserver(updateBlocks);
      subscription.observe(content, { childList: true, subtree: true });
      observer = subscription;
      return () => {
        subscription.disconnect();
        observer = undefined;
      };
    },

    clear() {
      anchor = undefined;
    },
  };
}
