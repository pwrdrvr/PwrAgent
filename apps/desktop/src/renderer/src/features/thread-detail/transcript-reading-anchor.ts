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

type ReadingBlockIndex = {
  elements: Element[];
  positionsById?: Map<string, number>;
};

function appendReadingBlock(index: ReadingBlockIndex, element: Element) {
  if (element.id) {
    index.positionsById ??= new Map();
    index.positionsById.set(element.id, index.elements.length);
  }
  index.elements.push(element);
}

function updateImageTiles(
  index: ReadingBlockIndex,
  line: Element,
  nodes: NodeList,
  append = false,
): boolean {
  const positions = index.positionsById;
  if (!positions) return false;
  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    const position = positions.get(node.id);
    const current = line.ownerDocument.getElementById(node.id);
    if (current?.parentElement !== line) return false;
    if (position === undefined) {
      if (!append || current !== node) return false;
      appendReadingBlock(index, node);
      continue;
    }
    // The preview and its error fallback share a tile id. Verify the slot
    // against its neighbors so removals and reorders rebuild.
    const { previousElementSibling: previous, nextElementSibling: next } = current;
    if (previous && positions.get(previous.id) !== position - 1) return false;
    const nextPosition = next ? positions.get(next.id) : undefined;
    // A later mutation record can carry an appending sibling after the last
    // indexed tile. Its own record verifies the append before indexing it.
    const nextIsNewTail = nextPosition === undefined && position === index.elements.length - 1;
    if (next && nextPosition !== position + 1 && !nextIsNewTail) return false;
    index.elements[position] = current;
  }
  return true;
}

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
  const rowBlocks = new WeakMap<Element, ReadingBlockIndex>();

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
          if (node.matches("article, aside")) appendReadingBlock(blocks, node);
          for (const block of node.querySelectorAll(INNER_READING_BLOCKS)) appendReadingBlock(blocks, block);
        }
        continue;
      }

      if (target.matches(IMAGE_LINES)) {
        // The folded gallery is the last block in its row. Live reviews can
        // add previews while it is being read, so index just the new tiles.
        const appending = removedNodes.length === 0 && nextSibling === null
          && target.matches(".transcript-work-phase-group__images");
        if (!updateImageTiles(blocks, target, removedNodes)
          || !updateImageTiles(blocks, target, addedNodes, appending)) {
          rowBlocks.delete(row);
        }
        continue;
      }

      // Text streaming inside an existing block doesn't affect the index.
      if (target === row || target.matches(".transcript-work-phase-group__content")) {
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
        blocks = { elements: [] };
        for (const block of row.querySelectorAll(READING_BLOCK_SELECTOR)) appendReadingBlock(blocks, block);
        rowBlocks.set(row, blocks);
      }
      const element = blocks.elements.length > 0
        ? readingBlock(blocks.elements.length, (index) => blocks.elements[index], line)
        : firstBox;
      const rect = element.getBoundingClientRect();
      if (rect.height > 0) {
        anchor = { element, offset: rect.top - top + scroller.scrollTop };
      }
    },

    restore(scroller: HTMLElement, prepending = false): boolean {
      if (!anchor) return false;
      const { element } = anchor;
      if (!scroller.contains(element)) {
        const replacement = element.id && scroller.ownerDocument.getElementById(element.id);
        if (!replacement || !scroller.contains(replacement)) {
          anchor = undefined;
          return false;
        }
        anchor.element = replacement;
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
