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
const JSON_STRING_CONTENT = String.raw`(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*`;
const CLOSED_TITLE = new RegExp('^"' + JSON_STRING_CONTENT + '"');
const OPEN_TITLE = new RegExp('^"' + JSON_STRING_CONTENT + String.raw`(?:\\(?:u[\da-fA-F]{0,3})?)?`);
const BROWSER_REPL_TOOL = /(?:^|\/)(?:node_repl|cua_repl)\/js$/i;

function commentaryText(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): string | undefined {
  if (backend !== "codex" || message.role !== "assistant" || message.phase !== "commentary"
    || message.delivery) {
    return undefined;
  }
  const text = message.text.trimStart();
  if (message.parts?.some((part) => part.type !== "text" || part.text.trim() !== text.trimEnd())) {
    return undefined;
  }
  return text;
}

function readTitle(quotedTitle: string): string | undefined {
  const title = (JSON.parse(quotedTitle) as string).trim();
  return title && !/[\r\n]/.test(title) ? title : undefined;
}

export function parseCodexBrowserCompletionTitle(
  message: AppServerThreadMessageEntry,
  backend: AppServerBackendKind | undefined,
): string | undefined {
  const text = commentaryText(message, backend);
  if (!text?.startsWith(COMPLETION_PREFIX)) return undefined;
  const payload = text.slice(COMPLETION_PREFIX.length).trimEnd();
  const quotedTitle = CLOSED_TITLE.exec(payload)?.[0];
  if (!quotedTitle || payload.slice(quotedTitle.length) !== "}") return undefined;
  return readTitle(quotedTitle);
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
  const text = commentaryText(message, backend);
  if (text === undefined) return false;
  if (COMPLETION_PREFIX.startsWith(text)) return true;
  if (!text.startsWith(COMPLETION_PREFIX)) return false;
  const payload = text.slice(COMPLETION_PREFIX.length);
  const quotedTitle = CLOSED_TITLE.exec(payload)?.[0];
  if (!quotedTitle) return OPEN_TITLE.exec(payload)?.[0] === payload;
  const suffix = payload.slice(quotedTitle.length);
  return (suffix === "" || suffix.trimEnd() === "}") && Boolean(readTitle(quotedTitle));
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

export function buildBrowserUsePresentation(
  entry: AppServerThreadActivityEntry,
): AppServerThreadBrowserUsePresentation | undefined {
  const browserDetails = collectBrowserDetails(entry);
  if (browserDetails.length === 0) return entry.browserUse;

  const surfaceKeys = new Set<string>();
  let latestUrl: string | undefined;
  let latestScreenshotUrl: string | undefined;
  let cloudHandoff = false;
  const webMcpTools: AppServerThreadBrowserUseWebMcpTool[] = [];
  const seenWebMcpKeys = new Set<string>();

  for (const detail of browserDetails) {
    const meta = detail.browserUse;
    const surfaceKey = browserUseSurfaceKey(meta);
    if (surfaceKey) surfaceKeys.add(surfaceKey);
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
  const hasNonBrowserDetails = browserDetails.length < entry.details.length;
  const title = summarizeCodexBrowserUseDetails(entry.details) ?? entry.summary;

  return {
    title,
    surfaceLabel: ambiguousSurface
      ? "Multiple browsers"
      : formatBrowserSurfaceLabel({
          backend: latestMeta.backend,
          browserFamily: latestMeta.browserFamily,
          cloudHandoff: cloudHandoff || latestMeta.cloudHandoff,
        }),
    ...(!ambiguousSurface && latestMeta.backend ? { backend: latestMeta.backend } : {}),
    ...(!ambiguousSurface && latestMeta.browserFamily
      ? { browserFamily: latestMeta.browserFamily }
      : {}),
    ...(!ambiguousSurface && latestMeta.browserId ? { browserId: latestMeta.browserId } : {}),
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

function applyMatchedTitleToSummary(
  entry: AppServerThreadActivityEntry,
  presentation: AppServerThreadBrowserUsePresentation,
  matchedTitle: string,
): string {
  if (!presentation.hasNonBrowserDetails) {
    return matchedTitle;
  }
  const previousSuffix = ` · ${presentation.title}`;
  if (entry.summary.endsWith(previousSuffix)) {
    return `${entry.summary.slice(0, -previousSuffix.length)} · ${matchedTitle}`;
  }
  return entry.summary === presentation.title
    ? matchedTitle
    : `${entry.summary} · ${matchedTitle}`;
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
  let hasUnresolvedLaterBrowserCall = false;

  const resetSegment = (nextTurnId?: string, trackTurn = false): void => {
    segmentTurnId = nextTurnId;
    hasSegmentTurn = trackTurn;
    candidateIndex = undefined;
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
          const updatedPresentation: AppServerThreadBrowserUsePresentation = {
            ...candidate.browserUse,
            title: completionTitle,
          };
          result[candidateIndex!] = {
            ...candidate,
            summary: applyMatchedTitleToSummary(
              candidate,
              candidate.browserUse,
              completionTitle,
            ),
            browserUse: updatedPresentation,
          };
          changed = true;
          // One marker claims one browser segment; a second marker without new
          // browser work stays standalone in place.
          candidateIndex = undefined;
          hasUnresolvedLaterBrowserCall = false;
          continue;
        }

        // Missing or ambiguous metadata: keep the standalone marker in place
        // and end the current browser segment.
        candidateIndex = undefined;
        hasUnresolvedLaterBrowserCall = false;
        result.push(entry);
        continue;
      }

      result.push(entry);
      continue;
    }

    if (entry.type === "activity") {
      const presentation = buildBrowserUsePresentation(entry);
      if (presentation) {
        const enriched: AppServerThreadActivityEntry =
          entry.browserUse === presentation
            ? entry
            : { ...entry, browserUse: presentation };
        if (enriched !== entry) changed = true;
        candidateIndex = result.length;
        hasUnresolvedLaterBrowserCall = hasTrailingUnresolvedBrowserCall(enriched);
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
