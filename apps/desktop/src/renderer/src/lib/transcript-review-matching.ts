import type { AppServerThreadEntry, AppServerThreadReviewEntry } from "@pwragent/shared/contracts/normalized-app-server";
import { normalizeReviewDisplayText } from "../../../shared/review-command";
import { isPendingEntryId } from "./pending-entry-id";

function reviewStartTimestamp(entry: AppServerThreadReviewEntry): number | undefined {
  let latest: number | undefined;
  for (const candidate of [
    entry.turn?.completedAt,
    entry.createdAt,
    entry.turn?.startedAt,
  ]) {
    if (typeof candidate === "number" && (latest === undefined || candidate > latest)) {
      latest = candidate;
    }
  }
  return latest;
}

function reviewStartAllowsUnboundLabelMatch(entry: AppServerThreadReviewEntry): boolean {
  // A native start with no turn ID can arrive even after completion. The
  // receipt-bound local header is still only a placeholder for that start.
  return entry.turn?.status === "in_progress" || isPendingEntryId(entry.id);
}

function reviewStartMatchesUnboundHeader(
  authoritative: AppServerThreadReviewEntry,
  unbound: AppServerThreadReviewEntry,
): boolean {
  if (reviewStartAllowsUnboundLabelMatch(authoritative)) {
    return true;
  }
  const unboundAt = unbound.createdAt;
  const authoritativeAt = reviewStartTimestamp(authoritative);
  return (
    typeof unboundAt === "number"
    && typeof authoritativeAt === "number"
    && authoritativeAt >= unboundAt
  );
}

export function reviewEntriesMatch(
  candidate: AppServerThreadReviewEntry,
  optimisticEntry: AppServerThreadReviewEntry
): boolean {
  const candidateIsStart = isReviewStartEntry(candidate);
  const optimisticIsStart = isReviewStartEntry(optimisticEntry);
  if (candidateIsStart !== optimisticIsStart) {
    return false;
  }

  const candidateTurnId = candidate.turn?.id;
  const optimisticTurnId = optimisticEntry.turn?.id;
  if (candidateTurnId && optimisticTurnId) {
    if (candidateTurnId !== optimisticTurnId) {
      return false;
    }
    if (candidateIsStart) {
      return true;
    }
  }

  // Two local headers can name the same target without belonging to the
  // same submission. Replacing the earlier one puts its findings after the
  // later header when the renderer merges reviews missing from the replay.
  if (candidateIsStart && isPendingEntryId(candidate.id) && isPendingEntryId(optimisticEntry.id)) {
    return candidate.id === optimisticEntry.id;
  }

  if (candidateIsStart && (candidateTurnId || optimisticTurnId)) {
    const authoritativeEntry = candidateTurnId ? candidate : optimisticEntry;
    const unboundEntry = candidateTurnId ? optimisticEntry : candidate;
    if (!reviewStartMatchesUnboundHeader(authoritativeEntry, unboundEntry)) {
      return false;
    }
  }

  const candidateLabels = reviewEntryLabels(candidate);
  const optimisticLabels = reviewEntryLabels(optimisticEntry);
  return optimisticLabels.some((label) => candidateLabels.includes(label));
}

export function isReviewStartEntry(entry: AppServerThreadReviewEntry): boolean {
  const displayText = entry.displayText?.trim();
  if (!displayText || entry.output) {
    return false;
  }

  if (entry.turn?.status === "in_progress") {
    return true;
  }

  const normalizedDisplayText = normalizeReviewDisplayText(displayText).toLocaleLowerCase();
  const normalizedReview = normalizeReviewDisplayText(entry.review).toLocaleLowerCase();
  return (
    normalizedDisplayText === normalizedReview ||
    normalizedDisplayText === "code review started" ||
    normalizedDisplayText.startsWith("review changes") ||
    normalizedDisplayText.startsWith("review current") ||
    normalizedDisplayText.startsWith("review commit")
  );
}

export function reviewEntryLabels(entry: AppServerThreadReviewEntry): string[] {
  return [entry.displayText, entry.review]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => normalizeReviewDisplayText(value).toLocaleLowerCase());
}

type ReplayReviewKeys = {
  all: Set<string>;
  settled: Set<string>;
  settledBoundStartMaxAt: Map<string, number>;
  unboundStartMinAtAll: Map<string, number>;
  unboundStartMinAtSettled: Map<string, number>;
};
const replayReviewIndexes = new WeakMap<AppServerThreadEntry[], ReplayReviewKeys>();

function recordMaxTime(map: Map<string, number>, key: string, time: number): void {
  const existing = map.get(key);
  if (existing === undefined || time > existing) {
    map.set(key, time);
  }
}

function recordMinTime(map: Map<string, number>, key: string, time: number): void {
  const existing = map.get(key);
  if (existing === undefined || time < existing) {
    map.set(key, time);
  }
}

function buildReplayReviewKeys(entry: AppServerThreadReviewEntry, lookup: boolean): string[] {
  const turnId = entry.turn?.id;
  const pending = isPendingEntryId(entry.id);
  const labels = reviewEntryLabels(entry);
  const keys: string[] = [];
  const addLabelKeys = (kind: string, subjects: string[]) => {
    for (const subject of subjects) keys.push(JSON.stringify([kind, subject]));
  };

  if (!isReviewStartEntry(entry)) {
    const owners = lookup && turnId ? [turnId, null] : lookup ? [false] : [turnId ?? null, false];
    for (const owner of owners) {
      for (const label of labels) {
        // An unbound result consumes the all-turn key; a bound one only its
        // own turn or legacy output with no turn.
        keys.push(JSON.stringify(["result", owner, label]));
      }
    }
    return keys;
  }

  if (turnId) keys.push(JSON.stringify(["start-turn", turnId]));
  if (pending) {
    if (!turnId || !lookup) keys.push(JSON.stringify(["pending-start-any", entry.id]));
    if (!turnId || lookup) keys.push(JSON.stringify(["pending-start-unbound", entry.id]));
  }
  if (turnId && !reviewStartAllowsUnboundLabelMatch(entry)) return keys;

  // A start with a different known turn never matches by label. The only
  // cross-identity label fallback is an unbound header, with at least one
  // side owned by replay. Index the eligible pairs rather than testing
  // every historical start with a popular label such as "Review main".
  if (lookup) {
    const namespaces = turnId ? ["unbound"] : ["unbound", "bound"];
    for (const namespace of namespaces) {
      addLabelKeys(`start-${namespace}-authoritative`, labels);
      if (!pending) addLabelKeys(`start-${namespace}-pending`, labels);
    }
  } else {
    addLabelKeys(`start-${turnId ? "bound" : "unbound"}-${pending ? "pending" : "authoritative"}`, labels);
  }
  return keys;
}

const indexedKeys = new WeakMap<AppServerThreadReviewEntry, string[]>();
const queriedKeys = new WeakMap<AppServerThreadReviewEntry, string[]>();

function replayReviewKeys(entry: AppServerThreadReviewEntry, lookup: boolean): string[] {
  const cache = lookup ? queriedKeys : indexedKeys;
  let keys = cache.get(entry);
  if (!keys) {
    keys = buildReplayReviewKeys(entry, lookup);
    cache.set(entry, keys);
  }
  return keys;
}

export function hasMatchingReplayReview(
  entries: AppServerThreadEntry[],
  review: AppServerThreadReviewEntry,
  retainInProgress: boolean | undefined,
): boolean {
  let index = replayReviewIndexes.get(entries);
  if (!index) {
    index = {
      all: new Set(),
      settled: new Set(),
      settledBoundStartMaxAt: new Map(),
      unboundStartMinAtAll: new Map(),
      unboundStartMinAtSettled: new Map(),
    };
    for (const entry of entries) {
      if (entry.type !== "review") continue;
      const isSettled = entry.turn?.status !== "in_progress";
      for (const key of replayReviewKeys(entry, false)) {
        index.all.add(key);
        if (isSettled) index.settled.add(key);
      }
      if (isReviewStartEntry(entry)) {
        const ownership = isPendingEntryId(entry.id) ? "pending" : "authoritative";
        const labels = reviewEntryLabels(entry);
        if (entry.turn?.id && isSettled) {
          const at = reviewStartTimestamp(entry);
          if (typeof at === "number") {
            for (const label of labels) {
              recordMaxTime(index.settledBoundStartMaxAt, `${ownership}:${label}`, at);
            }
          }
        } else if (!entry.turn?.id && typeof entry.createdAt === "number") {
          for (const label of labels) {
            recordMinTime(index.unboundStartMinAtAll, `${ownership}:${label}`, entry.createdAt);
            if (isSettled) {
              recordMinTime(index.unboundStartMinAtSettled, `${ownership}:${label}`, entry.createdAt);
            }
          }
        }
      }
    }
    replayReviewIndexes.set(entries, index);
  }
  // Running snapshots can regress. Keep the live fallback until a terminal
  // snapshot acknowledges it when requested by the hydration path.
  const keys = retainInProgress ? index.settled : index.all;
  if (replayReviewKeys(review, true).some((key) => keys.has(key))) {
    return true;
  }
  if (!isReviewStartEntry(review)) {
    return false;
  }
  const pending = isPendingEntryId(review.id);
  const labels = reviewEntryLabels(review);
  if (!review.turn?.id && typeof review.createdAt === "number") {
    for (const label of labels) {
      const authMax = index.settledBoundStartMaxAt.get(`authoritative:${label}`);
      if (authMax !== undefined && authMax >= review.createdAt) {
        return true;
      }
      if (!pending) {
        const pendingMax = index.settledBoundStartMaxAt.get(`pending:${label}`);
        if (pendingMax !== undefined && pendingMax >= review.createdAt) {
          return true;
        }
      }
    }
  } else if (review.turn?.id && review.turn.status !== "in_progress") {
    const at = reviewStartTimestamp(review);
    if (typeof at === "number") {
      const unboundMin = retainInProgress ? index.unboundStartMinAtSettled : index.unboundStartMinAtAll;
      for (const label of labels) {
        const authMin = unboundMin.get(`authoritative:${label}`);
        if (authMin !== undefined && authMin <= at) {
          return true;
        }
        if (!pending) {
          const pendingMin = unboundMin.get(`pending:${label}`);
          if (pendingMin !== undefined && pendingMin <= at) {
            return true;
          }
        }
      }
    }
  }
  return false;
}
