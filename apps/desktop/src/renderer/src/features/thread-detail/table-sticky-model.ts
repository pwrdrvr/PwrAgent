export type HorizontalScrollEdges = {
  left: boolean;
  right: boolean;
};

export type PinFirstColumnRecommendation = "auto" | "eligible" | "none";

export type StickyHeaderMetrics = {
  headerHeight: number;
  stickyTopInset?: number;
  tableBottom: number;
  tableTop: number;
  viewportBottom: number;
  viewportTop: number;
};

export type StickyHeaderState = {
  active: boolean;
  offsetY: number;
};

export type PinnedColumnMetrics = {
  clientWidth: number;
  desiredPinned: boolean;
  eligible: boolean;
  firstColumnWidth: number;
  scrollLeft: number;
  scrollWidth: number;
};

export type PinnedColumnState = {
  active: boolean;
  pinnedWidthPx: number;
  scrolledUnder: boolean;
};

// 1px tolerance absorbs sub-pixel rounding at fractional display scales so a
// table that fits or reaches its scroll end does not leave a stray edge fade.
export const SCROLL_EDGE_TOLERANCE_PX = 1;

// Sub-pixel threshold below which a table header is still flush with the top
// edge and does not need a sticky transform or elevation shadow.
const STICKY_HEADER_ACTIVATION_EPSILON_PX = 0.5;

// Never let a sticky header occupy half or more of the visible scrollport.
const STICKY_HEADER_MAX_VIEWPORT_SHARE = 0.5;

// Keep at least this much horizontal scrolling area visible to the right of a
// pinned first column so narrow split panes remain readable.
const PINNED_COLUMN_MIN_REMAINING_VIEWPORT_PX = 120;
const PINNED_COLUMN_MAX_VIEWPORT_SHARE = 0.52;
const PINNED_COLUMN_SOFT_FLOOR_PX = 240;

export function computeHorizontalScrollEdges(metrics: {
  clientWidth: number;
  scrollLeft: number;
  scrollWidth: number;
}): HorizontalScrollEdges {
  if (
    !Number.isFinite(metrics.clientWidth)
    || !Number.isFinite(metrics.scrollLeft)
    || !Number.isFinite(metrics.scrollWidth)
  ) {
    return { left: false, right: false };
  }
  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  if (maxScrollLeft <= SCROLL_EDGE_TOLERANCE_PX) {
    return { left: false, right: false };
  }
  return {
    left: metrics.scrollLeft > SCROLL_EDGE_TOLERANCE_PX,
    right: metrics.scrollLeft < maxScrollLeft - SCROLL_EDGE_TOLERANCE_PX,
  };
}

/**
 * Computes the vertical translation needed to keep a table's `<thead>` pinned
 * at the top of its vertical scroll container while the table body remains on
 * screen. The offset is strictly bounded inside `[0, tableHeight - headerHeight]`
 * so the header never overhangs past the last row of its table.
 */
export function computeStickyHeaderState(
  metrics: StickyHeaderMetrics,
): StickyHeaderState {
  const stickyTopInset = metrics.stickyTopInset ?? 0;
  if (
    !Number.isFinite(metrics.viewportTop)
    || !Number.isFinite(metrics.viewportBottom)
    || !Number.isFinite(metrics.tableTop)
    || !Number.isFinite(metrics.tableBottom)
    || !Number.isFinite(metrics.headerHeight)
    || !Number.isFinite(stickyTopInset)
  ) {
    return { active: false, offsetY: 0 };
  }

  const effectiveInset = Math.max(0, stickyTopInset);
  const effectiveViewportTop = metrics.viewportTop + effectiveInset;
  const availableViewportHeight = metrics.viewportBottom - effectiveViewportTop;
  const tableHeight = metrics.tableBottom - metrics.tableTop;

  if (
    availableViewportHeight <= 0
    || tableHeight <= 0
    || metrics.headerHeight <= 0
  ) {
    return { active: false, offsetY: 0 };
  }

  if (metrics.headerHeight >= availableViewportHeight * STICKY_HEADER_MAX_VIEWPORT_SHARE) {
    return { active: false, offsetY: 0 };
  }

  const maxOffset = tableHeight - metrics.headerHeight;
  if (maxOffset <= SCROLL_EDGE_TOLERANCE_PX) {
    return { active: false, offsetY: 0 };
  }

  if (
    metrics.tableTop >= effectiveViewportTop
    || metrics.tableBottom <= effectiveViewportTop
  ) {
    return { active: false, offsetY: 0 };
  }

  const rawOffset = effectiveViewportTop - metrics.tableTop;
  const clampedOffset = Math.min(Math.max(0, rawOffset), maxOffset);
  if (clampedOffset <= STICKY_HEADER_ACTIVATION_EPSILON_PX) {
    return { active: false, offsetY: 0 };
  }

  // Round to 0.5px increments to match half-pixel Retina coordinates without
  // churning CSS custom properties on micro-jitter.
  const roundedOffset = Math.min(maxOffset, Math.round(clampedOffset * 2) / 2);
  return {
    active: roundedOffset > STICKY_HEADER_ACTIVATION_EPSILON_PX,
    offsetY: roundedOffset > STICKY_HEADER_ACTIVATION_EPSILON_PX ? roundedOffset : 0,
  };
}

/**
 * Determines whether column 0 can safely stay horizontally pinned while the
 * table scrolls right. Rejects tables that fit without scrolling and protects
 * narrow panes where pinning column 0 would starve the remaining columns.
 */
export function computePinnedFirstColumnState(
  metrics: PinnedColumnMetrics,
): PinnedColumnState {
  if (
    !metrics.desiredPinned
    || !metrics.eligible
    || !Number.isFinite(metrics.clientWidth)
    || !Number.isFinite(metrics.scrollWidth)
    || !Number.isFinite(metrics.scrollLeft)
    || !Number.isFinite(metrics.firstColumnWidth)
    || metrics.clientWidth <= 0
    || metrics.firstColumnWidth <= 0
  ) {
    return { active: false, pinnedWidthPx: 0, scrolledUnder: false };
  }

  const maxScrollLeft = Math.max(0, metrics.scrollWidth - metrics.clientWidth);
  if (maxScrollLeft <= SCROLL_EDGE_TOLERANCE_PX) {
    return { active: false, pinnedWidthPx: 0, scrolledUnder: false };
  }

  const maxAllowedPinnedWidth = Math.min(
    metrics.clientWidth - PINNED_COLUMN_MIN_REMAINING_VIEWPORT_PX,
    Math.max(
      PINNED_COLUMN_SOFT_FLOOR_PX,
      metrics.clientWidth * PINNED_COLUMN_MAX_VIEWPORT_SHARE,
    ),
  );
  if (maxAllowedPinnedWidth <= 0 || metrics.firstColumnWidth > maxAllowedPinnedWidth) {
    return { active: false, pinnedWidthPx: 0, scrolledUnder: false };
  }

  return {
    active: true,
    pinnedWidthPx: Math.round(metrics.firstColumnWidth),
    scrolledUnder: metrics.scrollLeft > SCROLL_EDGE_TOLERANCE_PX,
  };
}

export function canOfferColumnPin(
  recommendation: PinFirstColumnRecommendation | undefined,
): boolean {
  return recommendation === "auto" || recommendation === "eligible";
}

export function parsePinFirstColumnRecommendation(
  value: unknown,
): PinFirstColumnRecommendation {
  if (value === "auto" || value === "eligible") {
    return value;
  }
  return "none";
}

/**
 * Case-insensitive whitespace-tokenized AND matcher used by the table viewer's
 * row filter. An empty or whitespace-only query matches every row.
 */
export function matchesTableRowFilter(rowText: string, query: string): boolean {
  const tokens = tokenizeFilterQuery(query);
  if (tokens.length === 0) {
    return true;
  }
  const haystack = rowText.toLowerCase();
  for (const token of tokens) {
    if (!haystack.includes(token)) {
      return false;
    }
  }
  return true;
}

export function tokenizeFilterQuery(query: string): string[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) {
    return [];
  }
  return trimmed.split(/\s+/);
}

/**
 * Serializes a rectangular or ragged grid of cell texts as RFC 4180 CSV.
 */
export function serializeTableCellsToCsv(
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string {
  return rows
    .map((row) =>
      row.length === 1 && row[0] === ""
        ? "\"\""
        : row.map(escapeCsvCell).join(","),
    )
    .join("\r\n");
}

function escapeCsvCell(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (/[,"\n]/.test(normalized)) {
    return `"${normalized.replace(/"/g, "\"\"")}"`;
  }
  return normalized;
}

const GFM_TABLE_DELIMITER_LINE_PATTERN =
  /^\|?[ \t]*:?-{1,}:?[ \t]*(?:\|[ \t]*:?-{1,}:?[ \t]*)*\|?$/;

function stripMarkdownContainerPrefix(line: string): string {
  return line.replace(/^(?:[ \t]*>[ \t]?)+/, "").trimStart();
}

/**
 * Normalizes a table source slice extracted via mdast offsets so tables nested
 * inside blockquotes (e.g. `> | A | B |`) or indented list items remain valid
 * standalone GFM tables when rendered inside `TableDocumentModal`. Falls back
 * to DOM-serialized Markdown if the normalized slice does not start with a
 * valid GFM header + delimiter row.
 */
export function normalizeExtractedTableMarkdown(
  rawSource: string | undefined,
  fallbackMarkdown: string,
): string {
  const trimmed = rawSource?.trim() ?? "";
  if (!trimmed) {
    return fallbackMarkdown;
  }

  const lines = trimmed.split(/\r?\n/);
  const hasContainerPrefix = lines.some((line) =>
    /^[ \t]*>/.test(line) || /^[ \t]{4,}/.test(line),
  );
  const candidateLines = hasContainerPrefix
    ? lines.map(stripMarkdownContainerPrefix)
    : lines;

  if (candidateLines.length >= 2) {
    const headerLine = candidateLines[0] ?? "";
    const delimiterLine = candidateLines[1] ?? "";
    const hasPipe = headerLine.includes("|") || delimiterLine.includes("|");
    if (hasPipe && GFM_TABLE_DELIMITER_LINE_PATTERN.test(delimiterLine.trim())) {
      return candidateLines.join("\n").trim();
    }
  }

  return fallbackMarkdown || trimmed;
}

/**
 * Looks immediately before a table's start offset in Markdown source for an ATX
 * heading (ignoring blank lines and thematic breaks) so the table viewer can
 * title itself after the section heading that introduced the table.
 */
export function extractTableTitleFromMarkdown(
  markdown: string,
  tableStartOffset: number | undefined,
): string | undefined {
  if (
    typeof tableStartOffset !== "number"
    || !Number.isFinite(tableStartOffset)
    || tableStartOffset <= 0
  ) {
    return undefined;
  }
  const prefix = markdown.slice(0, Math.min(tableStartOffset, markdown.length));
  const lines = prefix.split(/\r?\n/);
  let index = lines.length - 1;
  while (index >= 0) {
    const trimmed = stripMarkdownContainerPrefix(lines[index] ?? "").trim();
    if (
      trimmed === ""
      || /^(?:(?:\*\s*){3,}|(?:_\s*){3,}|(?:-\s*){3,})$/.test(trimmed)
    ) {
      index -= 1;
      continue;
    }
    const headingMatch = /^#{1,6}\s+(.+?)(?:\s+#+\s*)?$/.exec(trimmed);
    if (!headingMatch) {
      return undefined;
    }
    const cleaned = (headingMatch[1] ?? "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/[*_`~]/g, "")
      .trim();
    return cleaned || undefined;
  }
  return undefined;
}
