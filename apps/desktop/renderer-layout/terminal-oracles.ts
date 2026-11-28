const pixelTolerance = 0.25;

function requiredElement(parent: ParentNode, selector: string): HTMLElement {
  const element = parent.querySelector<HTMLElement>(selector);
  if (!element) throw new Error(`Terminal layout is missing ${selector}`);
  return element;
}

/** Intersect the viewport with each intervening CSS clipping ancestor. */
function verticalClip(parent: HTMLElement | null) {
  let top = 0;
  let bottom = window.innerHeight;
  for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).overflowY === "visible") continue;
    const rect = ancestor.getBoundingClientRect();
    const clipTop = rect.top + ancestor.clientTop;
    top = Math.max(top, clipTop);
    bottom = Math.min(bottom, clipTop + ancestor.clientHeight);
  }
  return { top, bottom };
}

function isFullyPainted(element: HTMLElement, bounds: DOMRect, clip: ReturnType<typeof verticalClip>): boolean {
  return bounds.width > 0 && bounds.height > 0
    && getComputedStyle(element).visibility === "visible"
    && bounds.top >= clip.top - pixelTolerance && bounds.bottom <= clip.bottom + pixelTolerance;
}

export function measureTerminalLayout(ptyRows: ReadonlyMap<string, number>) {
  const panel = requiredElement(document, ".thread-terminal-panel");
  const pane = requiredElement(panel, '[role="tabpanel"]:not([hidden])');
  const sessionId = pane.id.replace(/^terminal-panel-/, "");
  const viewport = requiredElement(pane, ".integrated-terminal__viewport").getBoundingClientRect();
  const rowList = requiredElement(pane, ".xterm-rows");
  const rows = [...rowList.querySelectorAll<HTMLElement>(":scope > div")];
  const rowBounds = rows.map((row) => row.getBoundingClientRect());
  const rowClip = verticalClip(rowList);
  const first = rowBounds[0];
  const last = rowBounds.at(-1);
  if (!first || !last || !first.height) throw new Error("xterm did not draw a row grid");

  const panelBounds = panel.getBoundingClientRect();
  const alert = pane.querySelector('[role="alert"]');
  const ended = pane.querySelector<HTMLElement>(".thread-terminal-panel__ended");
  const grip = requiredElement(panel, '[role="separator"]');
  const gripBounds = grip.getBoundingClientRect();
  // Press inside the strip's left half, clear of the rail's intentional
  // flyout over the right side of the terminal.
  const gripPoint = {
    x: Math.round(gripBounds.left + gripBounds.width / 4),
    y: Math.round(gripBounds.top + gripBounds.height / 2),
  };
  const newTerminal = requiredElement(panel, '[aria-label="New terminal"]');
  const button = newTerminal.getBoundingClientRect();
  const endedPainted = ended && isFullyPainted(ended, ended.getBoundingClientRect(), verticalClip(ended.parentElement));

  return {
    sessionId,
    // O1: above the first row there is room only for padding and a visible error.
    topGap: first.top - panelBounds.top - (alert?.getBoundingClientRect().height ?? 0),
    hasError: Boolean(alert),
    // O2: every grid row and the ended bar must fit the paintable area.
    gridRows: rows.length,
    paintedRows: rows.filter((row, index) => isFullyPainted(row, rowBounds[index]!, rowClip)).length,
    endedBar: ended ? (endedPainted ? "painted" : "clipped") : "absent",
    // O3: measure inside the viewport to exclude the shell's bottom padding.
    bottomGap: viewport.bottom - last.bottom,
    rowHeight: first.height,
    // O4: the grip stays off the first row and owns its press target.
    gripPoint,
    gripClearance: first.top - gripBounds.bottom,
    gripHit: document.elementFromPoint(gripPoint.x, gripPoint.y) === grip,
    newTerminalHit: newTerminal.contains(document.elementFromPoint((button.left + button.right) / 2, button.top + 1)),
    // O5: the last size sent to the bridge is independent of the DOM grid.
    ptyRows: ptyRows.get(sessionId),
    // O4/O6: use the pre-input painted height to predict the resize.
    paintedHeight: panelBounds.height,
    rememberedHeight: Number.parseFloat(panel.style.getPropertyValue("--integrated-terminal-height")),
  };
}
