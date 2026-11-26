import {
  browserUseSurfaceKey,
  formatBrowserSurfaceLabel,
  summarizeCodexBrowserUseDetails,
} from "@pwragent/shared/codex-browser-use";
import type {
  AppServerBackendKind,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadBrowserUseDetail,
  AppServerThreadBrowserUsePresentation,
  AppServerThreadBrowserUseWebMcpTool,
  AppServerThreadEntry,
  AppServerThreadMessageEntry,
} from "@pwragent/shared/contracts/normalized-app-server";

const COMPLETION_PREFIX = "::browser-complete{title=";
const BROWSER_REPL_TOOL = /(?:^|\/)(?:node_repl|cua_repl)\/js$/i;
// Compact browser completion headlines are short one-line summaries. Bounding
// the directive scanner prevents quadratic work and unbounded buffering if a
// commentary stream starts with `::browser-complete{title=` and never closes.
const MAX_BROWSER_COMPLETION_CHARS = 2_048;

type CompletionScanResult =
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "complete"; title: string };

type CachedPresentation = {
  details: AppServerThreadActivityEntry["details"];
  summary: string;
  inputBrowserUse: AppServerThreadActivityEntry["browserUse"];
  presentation: AppServerThreadBrowserUsePresentation | undefined;
  enriched: AppServerThreadActivityEntry;
  hasTrailingUnresolved: boolean;
  claimedMarker: boolean;
  matchedTitle?: string;
  matchedEntry?: AppServerThreadActivityEntry;
};

const presentationCache = new WeakMap<AppServerThreadActivityEntry, CachedPresentation>();

const UNICODE_WHITESPACE_CHAR = /^\s$/u;

function isWhitespaceAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code < 0x80) {
    return (
      code === 32
      || code === 9
      || code === 10
      || code === 13
      || code === 11
      || code === 12
    );
  }
  return UNICODE_WHITESPACE_CHAR.test(text[index]!);
}

function isHexDigit(code: number): boolean {
  return (
    (code >= 48 && code <= 57)
    || (code >= 65 && code <= 70)
    || (code >= 97 && code <= 102)
  );
}

function firstNonWhitespaceIndex(text: string): number {
  let index = 0;
  while (index < text.length && isWhitespaceAt(text, index)) {
    index += 1;
  }
  return index;
}

function lastNonWhitespaceIndex(text: string, start: number): number {
  let end = text.length;
  while (end > start && isWhitespaceAt(text, end - 1)) {
    end -= 1;
  }
  return end;
}

function commentarySlice(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): { raw: string; start: number } | undefined {
  if (
    backend !== "codex"
    || message.role !== "assistant"
    || message.phase !== "commentary"
    || message.delivery
  ) {
    return undefined;
  }
  const raw = message.text;
  if (raw.length > MAX_BROWSER_COMPLETION_CHARS) {
    return undefined;
  }
  const start = firstNonWhitespaceIndex(raw);
  // Fast O(1) bailout: any commentary whose first non-whitespace character is
  // not `:` can never be a `::browser-complete{...}` directive or prefix of
  // one, so skip `message.parts` inspection and string allocations entirely.
  if (start < raw.length && raw.charCodeAt(start) !== 58 /* ':' */) {
    return undefined;
  }
  if (message.parts) {
    const end = lastNonWhitespaceIndex(raw, start);
    const trimmed = raw.slice(start, end);
    if (message.parts.some((part) => part.type !== "text" || part.text.trim() !== trimmed)) {
      return undefined;
    }
  }
  return { raw, start };
}

function readTitle(quotedTitle: string): string | undefined {
  const title = (JSON.parse(quotedTitle) as string).trim();
  return title && !/[\r\n]/.test(title) ? title : undefined;
}

/**
 * Single-pass, zero-backtracking scanner for `::browser-complete{title="..."}`
 * and its valid streaming prefixes. Runs in O(1) on ordinary commentary and
 * O(length <= MAX_BROWSER_COMPLETION_CHARS) on candidate directives.
 */
function scanCodexBrowserCompletion(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): CompletionScanResult {
  const slice = commentarySlice(message, backend);
  if (!slice) return { kind: "none" };
  const { raw, start } = slice;
  const remaining = raw.length - start;
  if (remaining === 0) {
    return { kind: "pending" };
  }
  if (remaining <= COMPLETION_PREFIX.length) {
    for (let index = 0; index < remaining; index += 1) {
      if (raw.charCodeAt(start + index) !== COMPLETION_PREFIX.charCodeAt(index)) {
        return { kind: "none" };
      }
    }
    return { kind: "pending" };
  }
  for (let index = 0; index < COMPLETION_PREFIX.length; index += 1) {
    if (raw.charCodeAt(start + index) !== COMPLETION_PREFIX.charCodeAt(index)) {
      return { kind: "none" };
    }
  }

  let cursor = start + COMPLETION_PREFIX.length;
  if (raw.charCodeAt(cursor) !== 34 /* '"' */) {
    return { kind: "none" };
  }
  const quoteStart = cursor;
  cursor += 1;

  while (cursor < raw.length) {
    const code = raw.charCodeAt(cursor);
    if (code === 34 /* '"' */) {
      const quotedTitle = raw.slice(quoteStart, cursor + 1);
      const title = readTitle(quotedTitle);
      if (!title) return { kind: "none" };
      const afterQuote = cursor + 1;
      if (afterQuote === raw.length) {
        return { kind: "pending" };
      }
      if (raw.charCodeAt(afterQuote) !== 125 /* '}' */) {
        return { kind: "none" };
      }
      for (let tail = afterQuote + 1; tail < raw.length; tail += 1) {
        if (!isWhitespaceAt(raw, tail)) {
          return { kind: "none" };
        }
      }
      return { kind: "complete", title };
    }
    if (code < 0x20) {
      return { kind: "none" };
    }
    if (code === 92 /* '\\' */) {
      cursor += 1;
      if (cursor === raw.length) {
        return { kind: "pending" };
      }
      const escaped = raw.charCodeAt(cursor);
      if (escaped === 117 /* 'u' */) {
        cursor += 1;
        const hexAvailable = Math.min(4, raw.length - cursor);
        for (let hex = 0; hex < hexAvailable; hex += 1) {
          if (!isHexDigit(raw.charCodeAt(cursor + hex))) {
            return { kind: "none" };
          }
        }
        if (hexAvailable < 4) {
          return { kind: "pending" };
        }
        cursor += 4;
        continue;
      }
      if (
        escaped !== 34 /* '"' */
        && escaped !== 92 /* '\\' */
        && escaped !== 47 /* '/' */
        && escaped !== 98 /* 'b' */
        && escaped !== 102 /* 'f' */
        && escaped !== 110 /* 'n' */
        && escaped !== 114 /* 'r' */
        && escaped !== 116 /* 't' */
      ) {
        return { kind: "none" };
      }
    }
    cursor += 1;
  }

  return { kind: "pending" };
}

export function parseCodexBrowserCompletionTitle(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): string | undefined {
  const scanned = scanCodexBrowserCompletion(message, backend);
  return scanned.kind === "complete" ? scanned.title : undefined;
}

export function codexBrowserCompletionActivity(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): AppServerThreadActivityEntry | undefined {
  const title = parseCodexBrowserCompletionTitle(message, backend);
  if (!title) return undefined;
  return {
    type: "activity",
    id: message.id,
    createdAt: message.createdAt,
    summary: title,
    status: "completed",
    details: [],
    browserUse: {
      standalone: true,
      title,
      stepCount: 0,
    },
  };
}

export function isPendingCodexBrowserCompletion(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): boolean {
  return scanCodexBrowserCompletion(message, backend).kind !== "none";
}

function isUnresolvedBrowserReplDetail(detail: AppServerThreadActivityDetail): boolean {
  if (detail.browserUse || detail.status !== "in_progress") return false;
  const rawCommand = detail.command?.rawCommand?.trim() ?? "";
  return BROWSER_REPL_TOOL.test(rawCommand)
    || /\b(?:node_repl|cua_repl)\/js\b/i.test(detail.label);
}

function collectBrowserDetails(
  entry: AppServerThreadActivityEntry,
): Array<AppServerThreadActivityDetail & { browserUse: AppServerThreadBrowserUseDetail }> {
  return entry.details.filter(
    (detail): detail is AppServerThreadActivityDetail & {
      browserUse: AppServerThreadBrowserUseDetail;
    } => Boolean(detail.browserUse),
  );
}

function computeBrowserUsePresentation(
  entry: AppServerThreadActivityEntry,
): AppServerThreadBrowserUsePresentation | undefined {
  const browserDetails = collectBrowserDetails(entry);
  if (browserDetails.length === 0) return entry.browserUse;

  const surfaceKeys = new Set<string>();
  let latestSurfaceMeta: AppServerThreadBrowserUseDetail | undefined;
  let latestBrowserFamily: string | undefined;
  let latestUrl: string | undefined;
  let latestScreenshotUrl: string | undefined;
  let cloudHandoff = false;
  const webMcpTools: AppServerThreadBrowserUseWebMcpTool[] = [];
  const seenWebMcpKeys = new Set<string>();

  for (const detail of browserDetails) {
    const meta = detail.browserUse;
    const surfaceKey = browserUseSurfaceKey(meta);
    if (surfaceKey) {
      surfaceKeys.add(surfaceKey);
      latestSurfaceMeta = meta;
    }
    if (meta.browserFamily) latestBrowserFamily = meta.browserFamily;
    if (meta.url) latestUrl = meta.url;
    if (meta.screenshotUrl) latestScreenshotUrl = meta.screenshotUrl;
    if (meta.cloudHandoff) cloudHandoff = true;
    for (const tool of meta.webMcpTools ?? []) {
      const key = `${tool.name}\u0000${tool.sourceHostname ?? ""}`;
      if (!seenWebMcpKeys.has(key)) {
        seenWebMcpKeys.add(key);
        webMcpTools.push(tool);
      }
    }
  }

  const ambiguousSurface = surfaceKeys.size > 1;
  const latestMeta = browserDetails[browserDetails.length - 1]!.browserUse;
  const surfaceMeta = latestSurfaceMeta ?? latestMeta;
  const resolvedBrowserFamily = surfaceMeta.browserFamily ?? latestBrowserFamily;
  const hasNonBrowserDetails = browserDetails.length < entry.details.length;
  // Preserve an already-associated non-standalone title so re-projecting an
  // already-projected entry is strictly idempotent.
  const title =
    entry.browserUse && !entry.browserUse.standalone && entry.browserUse.title
      ? entry.browserUse.title
      : summarizeCodexBrowserUseDetails(entry.details) ?? entry.summary;

  return {
    title,
    surfaceLabel: ambiguousSurface
      ? "Multiple browsers"
      : formatBrowserSurfaceLabel({
          backend: surfaceMeta.backend,
          browserFamily: resolvedBrowserFamily,
          cloudHandoff: cloudHandoff || surfaceMeta.cloudHandoff,
        }),
    ...(!ambiguousSurface && surfaceMeta.backend ? { backend: surfaceMeta.backend } : {}),
    ...(!ambiguousSurface && resolvedBrowserFamily
      ? { browserFamily: resolvedBrowserFamily }
      : {}),
    ...(!ambiguousSurface && surfaceMeta.browserId ? { browserId: surfaceMeta.browserId } : {}),
    ...(latestUrl ? { url: latestUrl } : {}),
    ...(latestMeta.handoffReason ? { handoffReason: latestMeta.handoffReason } : {}),
    ...(cloudHandoff ? { cloudHandoff: true } : {}),
    ...(latestMeta.sessionEnded ? { sessionEnded: true } : {}),
    ...(latestScreenshotUrl ? { screenshotUrl: latestScreenshotUrl } : {}),
    stepCount: browserDetails.length,
    ...(webMcpTools.length > 0 ? { webMcpTools } : {}),
    ...(hasNonBrowserDetails ? { hasNonBrowserDetails: true } : {}),
    ...(ambiguousSurface ? { ambiguousSurface: true } : {}),
  };
}

function getCachedBrowserEntry(entry: AppServerThreadActivityEntry): CachedPresentation {
  const cached = presentationCache.get(entry);
  if (
    cached
    && cached.details === entry.details
    && cached.summary === entry.summary
    && cached.inputBrowserUse === entry.browserUse
  ) {
    return cached;
  }
  const presentation = computeBrowserUsePresentation(entry);
  const enriched: AppServerThreadActivityEntry =
    !presentation || entry.browserUse === presentation
      ? entry
      : { ...entry, browserUse: presentation };
  const record: CachedPresentation = {
    details: entry.details,
    summary: entry.summary,
    inputBrowserUse: entry.browserUse,
    presentation,
    enriched,
    hasTrailingUnresolved: presentation ? hasTrailingUnresolvedBrowserCall(enriched) : false,
    claimedMarker: false,
  };
  presentationCache.set(entry, record);
  if (enriched !== entry) {
    presentationCache.set(enriched, {
      details: enriched.details,
      summary: enriched.summary,
      inputBrowserUse: enriched.browserUse,
      presentation,
      enriched,
      hasTrailingUnresolved: record.hasTrailingUnresolved,
      claimedMarker: false,
    });
  }
  return record;
}

export function buildBrowserUsePresentation(
  entry: AppServerThreadActivityEntry,
): AppServerThreadBrowserUsePresentation | undefined {
  return getCachedBrowserEntry(entry).presentation;
}

function applyMatchedTitleToSummary(
  entry: AppServerThreadActivityEntry,
  presentation: AppServerThreadBrowserUsePresentation,
  matchedTitle: string,
): string {
  if (!presentation.hasNonBrowserDetails) {
    return matchedTitle;
  }
  if (entry.summary === presentation.title) {
    return matchedTitle;
  }
  const segments = entry.summary.split(" · ");
  const titleSegments = presentation.title.split(" · ");
  if (titleSegments.length > 0 && titleSegments.length <= segments.length) {
    for (let start = segments.length - titleSegments.length; start >= 0; start -= 1) {
      let matched = true;
      for (let offset = 0; offset < titleSegments.length; offset += 1) {
        if (segments[start + offset] !== titleSegments[offset]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        segments.splice(start, titleSegments.length, matchedTitle);
        return segments.join(" · ");
      }
    }
  }
  return `${entry.summary} · ${matchedTitle}`;
}

function hasTrailingUnresolvedBrowserCall(entry: AppServerThreadActivityEntry): boolean {
  let lastBrowserIndex = -1;
  for (let index = entry.details.length - 1; index >= 0; index -= 1) {
    if (entry.details[index]?.browserUse) {
      lastBrowserIndex = index;
      break;
    }
  }
  for (let index = lastBrowserIndex + 1; index < entry.details.length; index += 1) {
    const detail = entry.details[index];
    if (detail && isUnresolvedBrowserReplDetail(detail)) {
      return true;
    }
  }
  return false;
}

/**
 * Associates standalone Codex `::browser-complete{title="…"}` commentary with
 * the nearest preceding unambiguous Browser Use activity in the same turn,
 * keeping original item order, interleaved commentary/progress, and subsequent
 * work intact.
 *
 * When metadata is missing or ambiguous (no preceding browserUse activity,
 * multiple distinct browser surfaces in the candidate batch, an unresolved
 * in-progress browser REPL call, or a second marker after the candidate was
 * already claimed), the standalone marker stays in place and renders as a
 * compact standalone browser headline.
 */
export function projectCodexBrowserUseEntries(
  entries: AppServerThreadEntry[],
  backend: AppServerBackendKind | undefined,
  alwaysVisibleEntryIds?: ReadonlySet<string>,
): AppServerThreadEntry[] {
  if (backend !== "codex" || entries.length === 0) {
    return entries;
  }

  let changed = false;
  const result: AppServerThreadEntry[] = [];
  let segmentTurnId: string | undefined;
  let hasSegmentTurn = false;
  let candidateIndex: number | undefined;
  let candidateCache: CachedPresentation | undefined;
  let hasUnresolvedLaterBrowserCall = false;

  const resetSegment = (nextTurnId?: string, trackTurn = false): void => {
    segmentTurnId = nextTurnId;
    hasSegmentTurn = trackTurn;
    candidateIndex = undefined;
    candidateCache = undefined;
    hasUnresolvedLaterBrowserCall = false;
  };

  for (const entry of entries) {
    const entryTurnId = entry.turn?.id;
    if (hasSegmentTurn && entryTurnId !== segmentTurnId) {
      resetSegment(entryTurnId, true);
    } else if (!hasSegmentTurn) {
      segmentTurnId = entryTurnId;
      hasSegmentTurn = true;
    }

    if (entry.type === "review") {
      resetSegment(entryTurnId, true);
      result.push(entry);
      continue;
    }

    if (entry.type === "message") {
      if (entry.role === "user" || (entry.role === "assistant" && entry.phase === "final")) {
        resetSegment(entryTurnId, true);
        result.push(entry);
        continue;
      }

      const completionTitle = !alwaysVisibleEntryIds?.has(entry.id)
        ? parseCodexBrowserCompletionTitle(entry, backend)
        : undefined;
      if (completionTitle) {
        const candidate =
          candidateIndex !== undefined ? result[candidateIndex] : undefined;
        if (
          candidate?.type === "activity"
          && candidate.browserUse
          && !candidate.browserUse.ambiguousSurface
          && candidate.status !== "in_progress"
          && !hasUnresolvedLaterBrowserCall
        ) {
          let matchedEntry: AppServerThreadActivityEntry;
          if (
            candidateCache
            && candidateCache.matchedTitle === completionTitle
            && candidateCache.matchedEntry
          ) {
            matchedEntry = candidateCache.matchedEntry;
          } else {
            const updatedPresentation: AppServerThreadBrowserUsePresentation = {
              ...candidate.browserUse,
              title: completionTitle,
            };
            matchedEntry = {
              ...candidate,
              summary: applyMatchedTitleToSummary(
                candidate,
                candidate.browserUse,
                completionTitle,
              ),
              browserUse: updatedPresentation,
            };
            if (candidateCache) {
              candidateCache.matchedTitle = completionTitle;
              candidateCache.matchedEntry = matchedEntry;
              presentationCache.set(matchedEntry, {
                details: matchedEntry.details,
                summary: matchedEntry.summary,
                inputBrowserUse: matchedEntry.browserUse,
                presentation: updatedPresentation,
                enriched: matchedEntry,
                hasTrailingUnresolved: false,
                claimedMarker: true,
              });
            }
          }
          result[candidateIndex!] = matchedEntry;
          changed = true;
          // One marker claims one browser segment; a second marker without new
          // browser work stays standalone in place.
          candidateIndex = undefined;
          candidateCache = undefined;
          hasUnresolvedLaterBrowserCall = false;
          continue;
        }

        // Missing or ambiguous metadata: keep the standalone marker in place
        // and end the current browser segment.
        candidateIndex = undefined;
        candidateCache = undefined;
        hasUnresolvedLaterBrowserCall = false;
        result.push(entry);
        continue;
      }

      result.push(entry);
      continue;
    }

    if (entry.type === "activity") {
      const cached = getCachedBrowserEntry(entry);
      if (cached.presentation) {
        const enriched = cached.enriched;
        if (enriched !== entry) changed = true;
        if (cached.claimedMarker) {
          candidateIndex = undefined;
          candidateCache = undefined;
          hasUnresolvedLaterBrowserCall = false;
        } else {
          candidateIndex = result.length;
          candidateCache = cached;
          hasUnresolvedLaterBrowserCall = cached.hasTrailingUnresolved;
        }
        result.push(enriched);
        continue;
      }

      if (
        candidateIndex !== undefined
        && entry.details.some(isUnresolvedBrowserReplDetail)
      ) {
        hasUnresolvedLaterBrowserCall = true;
      }
      result.push(entry);
      continue;
    }

    result.push(entry);
  }

  return changed ? result : entries;
}
