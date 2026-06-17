import type {
  AppServerNotification,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadFileChangeKind,
  AppServerThreadFileDiffRef,
} from "@pwragent/shared";

const MAX_LIVE_DIFF_CACHE_ENTRIES = 2_000;

const liveDiffCache = new Map<string, { diff: string; storedAt: number }>();

function buildLiveDiffRef(params: {
  threadId: string;
  entryId: string;
  detailId: string;
}): AppServerThreadFileDiffRef {
  return {
    source: "live",
    key: `live:${params.threadId}:${params.entryId}:${params.detailId}`,
    threadId: params.threadId,
    entryId: params.entryId,
    detailId: params.detailId,
  };
}

function rememberLiveDiff(ref: AppServerThreadFileDiffRef, diff: string): void {
  liveDiffCache.set(ref.key, { diff, storedAt: Date.now() });
  if (liveDiffCache.size <= MAX_LIVE_DIFF_CACHE_ENTRIES) {
    return;
  }

  const entriesByAge = [...liveDiffCache.entries()].sort(
    (left, right) => left[1].storedAt - right[1].storedAt,
  );
  for (const [key] of entriesByAge.slice(
    0,
    liveDiffCache.size - MAX_LIVE_DIFF_CACHE_ENTRIES,
  )) {
    liveDiffCache.delete(key);
  }
}

export function getLiveThreadFileDiff(
  ref: AppServerThreadFileDiffRef,
): string | undefined {
  if (ref.source !== "live") {
    return undefined;
  }
  return liveDiffCache.get(ref.key)?.diff;
}

function summarizeDiff(diff: string): { additions: number; removals: number } {
  let additions = 0;
  let removals = 0;

  for (const line of diff.split("\n")) {
    if (
      !line ||
      line.startsWith("+++") ||
      line.startsWith("---") ||
      line.startsWith("@@") ||
      line.startsWith("\\")
    ) {
      continue;
    }

    if (line.startsWith("+")) {
      additions += 1;
      continue;
    }

    if (line.startsWith("-")) {
      removals += 1;
    }
  }

  return { additions, removals };
}

function normalizeDiffPath(path: string | undefined): string | undefined {
  if (!path || path === "/dev/null") {
    return undefined;
  }

  return path.replace(/^[ab]\//, "");
}

function inferDiffKind(lines: string[]): AppServerThreadFileChangeKind {
  const beforeLine = lines.find((line) => line.startsWith("--- "));
  const afterLine = lines.find((line) => line.startsWith("+++ "));

  if (beforeLine?.slice(4).trim() === "/dev/null") {
    return "add";
  }

  if (afterLine?.slice(4).trim() === "/dev/null") {
    return "delete";
  }

  return "update";
}

function getBasename(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

function buildDiffLabel(kind: AppServerThreadFileChangeKind, path?: string): string {
  const verb = kind[0]?.toUpperCase() + kind.slice(1);
  return `${verb} ${path ? getBasename(path) : "file"}`;
}

function formatChangedFileCount(params: {
  count: number;
  prefix: "Changed" | "Edited";
}): string {
  return `${params.prefix} ${params.count} file${params.count === 1 ? "" : "s"}`;
}

function formatChangedFileSummary(params: {
  count: number;
  prefix: "Changed" | "Edited";
  additions: number;
  removals: number;
}): string {
  const parts = [formatChangedFileCount(params)];
  if (params.additions > 0 || params.removals > 0) {
    parts.push(
      `+${params.additions.toLocaleString()}, -${params.removals.toLocaleString()}`,
    );
  }
  return parts.join(", ");
}

export function extractLiveDiffActivityDetails(params: {
  diff: string;
  entryId: string;
  threadId: string;
}): AppServerThreadActivityDetail[] {
  const lines = params.diff.replace(/\r\n?/g, "\n").split("\n");
  const sections: Array<{ lines: string[] }> = [];
  let currentSection: { lines: string[] } | undefined;

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (currentSection?.lines.length) {
        sections.push(currentSection);
      }
      currentSection = { lines: [line] };
      continue;
    }

    if (!currentSection) {
      currentSection = { lines: [] };
    }

    currentSection.lines.push(line);
  }

  if (currentSection?.lines.length) {
    sections.push(currentSection);
  }

  const normalizedSections = sections.length > 0 ? sections : [{ lines }];
  const details: AppServerThreadActivityDetail[] = [];

  for (const [index, section] of normalizedSections.entries()) {
    const rawBefore = section.lines.find((line) => line.startsWith("--- "))?.slice(4).trim();
    const rawAfter = section.lines.find((line) => line.startsWith("+++ "))?.slice(4).trim();
    const path = normalizeDiffPath(rawAfter) ?? normalizeDiffPath(rawBefore);
    const diffText = section.lines.join("\n").trim();

    if (!diffText) {
      continue;
    }

    const kind = inferDiffKind(section.lines);
    const diffSummary = summarizeDiff(diffText);
    const detailId = `${params.entryId}-${index + 1}`;
    const diffRef = buildLiveDiffRef({
      threadId: params.threadId,
      entryId: params.entryId,
      detailId,
    });
    rememberLiveDiff(diffRef, diffText);

    details.push({
      id: detailId,
      kind: "write",
      label: buildDiffLabel(kind, path),
      ...(path ? { path } : {}),
      fileDiff: {
        kind,
        diff: "",
        diffRef,
        additions: diffSummary.additions,
        removals: diffSummary.removals,
      },
    });
  }

  return details;
}

export function buildLiveDiffActivityEntry(
  notification: Extract<AppServerNotification, { method: "turn/diff/updated" }>,
): AppServerThreadActivityEntry | undefined {
  const entryId = `live-diff-${notification.params.turnId ?? notification.params.threadId}`;
  const details = extractLiveDiffActivityDetails({
    diff: notification.params.diff,
    entryId,
    threadId: notification.params.threadId,
  });
  if (details.length === 0) {
    return undefined;
  }
  const additions = details.reduce(
    (total, detail) => total + (detail.fileDiff?.additions ?? 0),
    0,
  );
  const removals = details.reduce(
    (total, detail) => total + (detail.fileDiff?.removals ?? 0),
    0,
  );

  return {
    type: "activity",
    id: entryId,
    createdAt: Date.now(),
    summary: formatChangedFileSummary({
      count: details.length,
      prefix: "Edited",
      additions,
      removals,
    }),
    details,
  };
}
