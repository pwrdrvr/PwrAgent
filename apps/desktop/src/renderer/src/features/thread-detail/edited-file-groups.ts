import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared";
import { formatChangedFileSummary } from "./live-transcript-activity";

/**
 * One accumulated set of file edits, normally a single turn's worth.
 * Groups build up across turns until a successful `git commit` lands;
 * the committed groups stay visible until the NEXT turn starts, then
 * drop (see `collectEditedFileGroups`).
 */
export type EditedFileGroup = {
  /** Stable render key: the turn id, or a synthetic per-entry key. */
  key: string;
  turn?: AppServerThreadTurnMetadata;
  /** Per-file details; every detail carries a `fileDiff`. */
  details: AppServerThreadActivityDetail[];
  /** "Edited N files, +A, -R" for this group. */
  summary: string;
  additions: number;
  removals: number;
  /** True when this group's turn also ran a successful `git commit`. */
  committed: boolean;
  /** True when this group is the in-flight turn's live cumulative diff. */
  live: boolean;
};

/**
 * Matches a `git … commit …` invocation at the start of a command or
 * after a shell connector. Only option-shaped tokens may sit between
 * `git` and `commit` (`-C <path>`, `-c key=val`, `--git-dir=…`) so
 * commands that merely mention "commit" later don't false-positive.
 */
const GIT_COMMIT_COMMAND = /(?:^|[;&|]\s*)git\s+(?:-{1,2}[\w-]+(?:[= ]\S+)?\s+)*commit\b/;

export function commandLooksLikeGitCommit(command: string): boolean {
  return GIT_COMMIT_COMMAND.test(command);
}

function isSuccessfulGitCommitDetail(detail: AppServerThreadActivityDetail): boolean {
  if (detail.kind !== "command" || !detail.command) {
    return false;
  }
  const command = detail.command.displayCommand || detail.command.rawCommand;
  if (!command || !commandLooksLikeGitCommit(command)) {
    return false;
  }
  if (typeof detail.command.exitCode === "number") {
    return detail.command.exitCode === 0;
  }
  return detail.status === "completed";
}

/**
 * Live cumulative turn diffs (from `turn/diff/updated`) are built with
 * this id prefix — see `buildPendingDiffEntry` in ThreadView. When a
 * turn has one, it is authoritative for that turn (it already folds
 * repeat edits of the same file together), so per-item file-change
 * entries from the same turn are ignored to avoid double counting.
 */
const LIVE_CUMULATIVE_DIFF_ID_PREFIX = "live-diff-";

type TurnBucket = {
  key: string;
  orderIndex: number;
  turn?: AppServerThreadTurnMetadata;
  detailsByKey: Map<string, AppServerThreadActivityDetail>;
  cumulative?: AppServerThreadActivityEntry;
  committed: boolean;
  live: boolean;
};

function mergeFileDiffDetail(
  existing: AppServerThreadActivityDetail | undefined,
  detail: AppServerThreadActivityDetail,
): AppServerThreadActivityDetail {
  if (!existing?.fileDiff || !detail.fileDiff) {
    return detail;
  }

  // A file added then updated within the window is still net-new; a
  // delete wins outright (the stacked diff preserves the history).
  const kind =
    detail.fileDiff.kind === "delete"
      ? "delete"
      : existing.fileDiff.kind === "add"
        ? "add"
        : detail.fileDiff.kind;

  return {
    ...existing,
    status: detail.status ?? existing.status,
    label: kind === existing.fileDiff.kind ? existing.label : detail.label,
    fileDiff: {
      kind,
      diff: `${existing.fileDiff.diff}\n${detail.fileDiff.diff}`,
      additions: existing.fileDiff.additions + detail.fileDiff.additions,
      removals: existing.fileDiff.removals + detail.fileDiff.removals,
      ...(detail.fileDiff.omittedReason
        ? { omittedReason: detail.fileDiff.omittedReason }
        : {}),
    },
  };
}

/**
 * Walk transcript entries (persisted replay + deferred live entries, in
 * order) and build the accumulated edited-file groups:
 *
 * - Edits group per turn; turns accumulate while nothing is committed.
 * - A successful `git commit` in turn C clears everything up to and
 *   including C — but only once a LATER turn exists (committed work
 *   stays on screen until the next turn starts).
 * - `livePendingEntry` (the in-flight turn's cumulative diff) renders
 *   as the newest group while a turn is streaming.
 *
 * Returns groups newest-first.
 */
export function collectEditedFileGroups(params: {
  entries: readonly AppServerThreadEntry[];
  activeTurnId?: string;
  livePendingEntry?: AppServerThreadActivityEntry;
}): EditedFileGroup[] {
  const turnOrder: string[] = [];
  const orderIndexByKey = new Map<string, number>();
  const buckets = new Map<string, TurnBucket>();

  const ensureTurnIndex = (key: string): number => {
    let index = orderIndexByKey.get(key);
    if (index === undefined) {
      index = turnOrder.length;
      turnOrder.push(key);
      orderIndexByKey.set(key, index);
    }
    return index;
  };

  const ensureBucket = (
    key: string,
    turn: AppServerThreadTurnMetadata | undefined,
  ): TurnBucket => {
    const orderIndex = ensureTurnIndex(key);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        orderIndex,
        turn,
        detailsByKey: new Map(),
        committed: false,
        live: false,
      };
      buckets.set(key, bucket);
    } else if (!bucket.turn && turn) {
      bucket.turn = turn;
    }
    return bucket;
  };

  for (const entry of params.entries) {
    const turnKey = entry.turn?.id;
    if (entry.type !== "activity") {
      // Non-activity entries still advance the turn order — a turn
      // that only produced messages still counts as "the next turn
      // started" for the committed-group clearing rule.
      if (turnKey) {
        ensureTurnIndex(turnKey);
      }
      continue;
    }

    const hasFileDiff = entry.details.some((detail) => detail.fileDiff);
    const hasCommit = entry.details.some(isSuccessfulGitCommitDetail);
    if (!hasFileDiff && !hasCommit) {
      if (turnKey) {
        ensureTurnIndex(turnKey);
      }
      continue;
    }

    const key = turnKey ?? `entry:${entry.id}`;
    const bucket = ensureBucket(key, entry.turn);
    if (hasCommit) {
      bucket.committed = true;
    }
    if (!hasFileDiff) {
      continue;
    }

    if (entry.id.startsWith(LIVE_CUMULATIVE_DIFF_ID_PREFIX)) {
      bucket.cumulative = entry;
      continue;
    }

    for (const detail of entry.details) {
      if (!detail.fileDiff) {
        continue;
      }
      const detailKey = detail.path ?? detail.id;
      bucket.detailsByKey.set(
        detailKey,
        mergeFileDiffDetail(bucket.detailsByKey.get(detailKey), detail),
      );
    }
  }

  if (params.livePendingEntry) {
    const key =
      params.livePendingEntry.turn?.id ?? params.activeTurnId ?? "live-turn";
    const bucket = ensureBucket(key, params.livePendingEntry.turn);
    bucket.cumulative = params.livePendingEntry;
    bucket.live = true;
  } else if (params.activeTurnId) {
    // An active turn with no edits yet still counts as "started" so
    // committed groups from prior turns clear immediately.
    ensureTurnIndex(params.activeTurnId);
  }

  const lastTurnIndex = turnOrder.length - 1;
  let clearThroughIndex = -1;
  for (const bucket of buckets.values()) {
    if (bucket.committed && bucket.orderIndex < lastTurnIndex) {
      clearThroughIndex = Math.max(clearThroughIndex, bucket.orderIndex);
    }
  }

  const groups: EditedFileGroup[] = [];
  for (const bucket of [...buckets.values()].sort(
    (left, right) => left.orderIndex - right.orderIndex,
  )) {
    if (bucket.orderIndex <= clearThroughIndex) {
      continue;
    }

    const details = bucket.cumulative
      ? bucket.cumulative.details.filter((detail) => detail.fileDiff)
      : [...bucket.detailsByKey.values()];
    if (details.length === 0) {
      continue;
    }

    const additions = details.reduce(
      (total, detail) => total + (detail.fileDiff?.additions ?? 0),
      0,
    );
    const removals = details.reduce(
      (total, detail) => total + (detail.fileDiff?.removals ?? 0),
      0,
    );
    groups.push({
      key: bucket.key,
      turn: bucket.turn,
      details,
      summary: formatChangedFileSummary({
        count: details.length,
        prefix: "Edited",
        additions,
        removals,
      }),
      additions,
      removals,
      committed: bucket.committed,
      live: bucket.live,
    });
  }

  return groups.reverse();
}

/**
 * Merge groups into a single per-file list ("current state" view).
 * Groups are newest-first; merging walks oldest→newest so stacked
 * diffs read chronologically. Returns files in first-edit order.
 */
export function flattenEditedFileGroups(
  groups: readonly EditedFileGroup[],
): AppServerThreadActivityDetail[] {
  const detailsByKey = new Map<string, AppServerThreadActivityDetail>();
  for (const group of [...groups].reverse()) {
    for (const detail of group.details) {
      const detailKey = detail.path ?? detail.id;
      detailsByKey.set(
        detailKey,
        mergeFileDiffDetail(detailsByKey.get(detailKey), detail),
      );
    }
  }
  return [...detailsByKey.values()];
}

/** Combined rail-title summary across all groups. */
export function summarizeEditedFileGroups(
  groups: readonly EditedFileGroup[],
): string | undefined {
  if (groups.length === 0) {
    return undefined;
  }
  const flattened = flattenEditedFileGroups(groups);
  const additions = groups.reduce((total, group) => total + group.additions, 0);
  const removals = groups.reduce((total, group) => total + group.removals, 0);
  const summary = formatChangedFileSummary({
    count: flattened.length,
    prefix: "Edited",
    additions,
    removals,
  });
  return groups.length > 1 ? `${summary} · ${groups.length} turns` : summary;
}
