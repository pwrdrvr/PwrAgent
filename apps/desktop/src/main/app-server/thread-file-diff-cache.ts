import { createHash } from "node:crypto";
import type {
  AppServerBackendKind,
  AppServerReadThreadResponse,
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadFileDiffRef,
} from "@pwragent/shared";

const MAX_THREAD_DIFF_CACHE_ENTRIES = 5_000;
const MAX_THREAD_DIFF_CACHE_CHARS = 20_000_000;

const threadDiffCache = new Map<string, { diff: string; storedAt: number }>();
let threadDiffCacheChars = 0;

function buildThreadDiffRef(params: {
  backend: AppServerBackendKind;
  threadId: string;
  entryId: string;
  detailId: string;
  diff: string;
}): AppServerThreadFileDiffRef {
  const hash = createHash("sha256")
    .update(params.diff)
    .digest("hex")
    .slice(0, 16);
  return {
    source: "thread",
    key: `thread:${params.backend}:${params.threadId}:${params.entryId}:${params.detailId}:${hash}`,
    backend: params.backend,
    threadId: params.threadId,
    entryId: params.entryId,
    detailId: params.detailId,
  };
}

function rememberThreadDiff(
  ref: AppServerThreadFileDiffRef,
  diff: string,
): void {
  const existing = threadDiffCache.get(ref.key);
  if (existing) {
    threadDiffCacheChars -= existing.diff.length;
  }
  threadDiffCache.set(ref.key, { diff, storedAt: Date.now() });
  threadDiffCacheChars += diff.length;

  if (
    threadDiffCache.size <= MAX_THREAD_DIFF_CACHE_ENTRIES
    && threadDiffCacheChars <= MAX_THREAD_DIFF_CACHE_CHARS
  ) {
    return;
  }

  const entriesByAge = [...threadDiffCache.entries()].sort(
    (left, right) => left[1].storedAt - right[1].storedAt,
  );
  for (const [key, value] of entriesByAge) {
    if (
      threadDiffCache.size <= MAX_THREAD_DIFF_CACHE_ENTRIES
      && threadDiffCacheChars <= MAX_THREAD_DIFF_CACHE_CHARS
    ) {
      break;
    }
    threadDiffCache.delete(key);
    threadDiffCacheChars -= value.diff.length;
  }
}

export function getThreadReplayFileDiff(
  ref: AppServerThreadFileDiffRef,
): string | undefined {
  if (ref.source !== "thread") {
    return undefined;
  }
  return threadDiffCache.get(ref.key)?.diff;
}

function shapeActivityDetailDiff(params: {
  backend: AppServerBackendKind;
  threadId: string;
  entryId: string;
  detail: AppServerThreadActivityDetail;
}): AppServerThreadActivityDetail {
  const fileDiff = params.detail.fileDiff;
  if (!fileDiff?.diff) {
    return params.detail;
  }

  if (fileDiff.omittedReason) {
    return {
      ...params.detail,
      fileDiff: {
        ...fileDiff,
        diff: "",
      },
    };
  }

  const diffRef = buildThreadDiffRef({
    backend: params.backend,
    threadId: params.threadId,
    entryId: params.entryId,
    detailId: params.detail.id,
    diff: fileDiff.diff,
  });
  rememberThreadDiff(diffRef, fileDiff.diff);

  return {
    ...params.detail,
    fileDiff: {
      ...fileDiff,
      diff: "",
      diffRef,
    },
  };
}

function shapeActivityEntryDiffs(params: {
  backend: AppServerBackendKind;
  threadId: string;
  entry: AppServerThreadActivityEntry;
}): AppServerThreadActivityEntry {
  let changed = false;
  const details = params.entry.details.map((detail) => {
    const shaped = shapeActivityDetailDiff({
      backend: params.backend,
      threadId: params.threadId,
      entryId: params.entry.id,
      detail,
    });
    changed = changed || shaped !== detail;
    return shaped;
  });

  return changed ? { ...params.entry, details } : params.entry;
}

function shapeThreadEntryDiffs(params: {
  backend: AppServerBackendKind;
  threadId: string;
  entry: AppServerThreadEntry;
}): AppServerThreadEntry {
  if (params.entry.type !== "activity") {
    return params.entry;
  }
  return shapeActivityEntryDiffs({
    backend: params.backend,
    threadId: params.threadId,
    entry: params.entry,
  });
}

export function shapeReadThreadFileDiffsForRenderer(
  response: AppServerReadThreadResponse,
): AppServerReadThreadResponse {
  let changed = false;
  const entries = response.replay.entries.map((entry) => {
    const shaped = shapeThreadEntryDiffs({
      backend: response.backend,
      threadId: response.threadId,
      entry,
    });
    changed = changed || shaped !== entry;
    return shaped;
  });

  if (!changed) {
    return response;
  }

  return {
    ...response,
    replay: {
      ...response.replay,
      entries,
    },
  };
}
