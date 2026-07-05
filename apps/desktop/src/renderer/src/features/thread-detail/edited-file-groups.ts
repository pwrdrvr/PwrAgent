import type {
  AppServerThreadActivityDetail,
  AppServerThreadActivityEntry,
  AppServerThreadEntry,
  AppServerThreadTurnMetadata,
} from "@pwragent/shared";
import {
  formatChangedFileCount,
  formatChangedFileSummary,
} from "./live-transcript-activity";

/**
 * Upper bound on accumulated turn-groups kept by `collectEditedFileGroups`.
 * Groups normally clear once a `git commit` lands, but a long stretch of
 * uncommitted turns would otherwise grow without bound — and each group
 * stacks its files' diff text, so the per-render cost grows with it. Keep the
 * newest N; older uncommitted turns drop off the rail (the summary totals then
 * reflect the retained set). Matches the directory list's `UNPINNED_THREAD_CAP`.
 */
export const MAX_RETAINED_TURN_GROUPS = 10;

/**
 * One accumulated set of file edits, normally a single turn's worth.
 * Groups build up across turns and stay viewable; their git lifecycle
 * (uncommitted → committed → pushed) is resolved separately against the
 * live worktree (see `resolveEditCommitStates`) rather than guessed from
 * the agent's command transcript.
 */
export type EditedFileGroup = {
  /** Stable render key: the turn id, or a synthetic per-entry key. */
  key: string;
  turn?: AppServerThreadTurnMetadata;
  /** Per-file details; every detail carries a `fileDiff`. */
  details: AppServerThreadActivityDetail[];
  /** "Edited N files" — file count only; +/- render via `DiffStat`. */
  summary: string;
  additions: number;
  removals: number;
  /** True when this group is the in-flight turn's live cumulative diff. */
  live: boolean;
};

/**
 * Collect the absolute file paths a group edited — the input to
 * `resolveEditCommitStates`, which maps them to a commit + push state.
 */
export function editGroupPaths(group: EditedFileGroup): string[] {
  const paths = new Set<string>();
  for (const detail of group.details) {
    const candidate = detail.path?.trim();
    if (candidate) {
      paths.add(candidate);
    }
  }
  return [...paths];
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
  const mergedDiffText =
    existing.fileDiff.diff || detail.fileDiff.diff
      ? `${existing.fileDiff.diff}\n${detail.fileDiff.diff}`
      : "";
  const fileDiffRefs = (fileDiff: AppServerThreadActivityDetail["fileDiff"]) =>
    fileDiff?.diffRefs ?? (fileDiff?.diffRef ? [fileDiff.diffRef] : []);
  const diffRefs = [
    ...fileDiffRefs(existing.fileDiff),
    ...fileDiffRefs(detail.fileDiff),
  ];
  const omittedReason =
    detail.fileDiff.omittedReason ?? existing.fileDiff.omittedReason;

  return {
    ...existing,
    status: detail.status ?? existing.status,
    label: kind === existing.fileDiff.kind ? existing.label : detail.label,
    fileDiff: {
      kind,
      diff: mergedDiffText,
      additions: existing.fileDiff.additions + detail.fileDiff.additions,
      removals: existing.fileDiff.removals + detail.fileDiff.removals,
      ...(mergedDiffText || diffRefs.length === 0
        ? {}
        : {
            diffRef: diffRefs[diffRefs.length - 1],
            diffRefs,
          }),
      ...(omittedReason ? { omittedReason } : {}),
    },
  };
}

/**
 * Walk transcript entries (persisted replay + deferred live entries, in
 * order) and build the accumulated edited-file groups:
 *
 * - Edits group per turn; turns accumulate and stay viewable. Groups are
 *   never cleared from the transcript — their committed/pushed lifecycle is
 *   resolved against the live worktree (see `resolveEditCommitStates`).
 * - `livePendingEntry` (the in-flight turn's cumulative diff) renders
 *   as the newest group while a turn is streaming.
 *
 * Returns groups newest-first, capped at `MAX_RETAINED_TURN_GROUPS`.
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
      continue;
    }

    const hasFileDiff = entry.details.some((detail) => detail.fileDiff);
    if (!hasFileDiff) {
      continue;
    }

    const key = turnKey ?? `entry:${entry.id}`;
    const bucket = ensureBucket(key, entry.turn);

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
  }

  const groups: EditedFileGroup[] = [];
  for (const bucket of [...buckets.values()].sort(
    (left, right) => left.orderIndex - right.orderIndex,
  )) {
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
      // Count only — the +/- stats render via the shared colored DiffStat
      // chip in the header (consistent with the thread-row dirty chip),
      // not as plain comma-separated text.
      summary: formatChangedFileCount({
        count: details.length,
        prefix: "Edited",
      }),
      additions,
      removals,
      live: bucket.live,
    });
  }

  // Newest-first, then bound retention so an uncommitted thread can't grow the
  // rail (and its stacked diffs) without limit. The live/active turn sorts
  // newest, so it is always kept.
  return groups.reverse().slice(0, MAX_RETAINED_TURN_GROUPS);
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
  // Count unique files via a key Set rather than `flattenEditedFileGroups`
  // — the title only needs the file count + totals, and flattening would
  // concatenate every group's diff text on each render (this runs in the
  // LiveWorkRail body on every turn/diff/updated delta).
  const fileKeys = new Set<string>();
  let additions = 0;
  let removals = 0;
  for (const group of groups) {
    additions += group.additions;
    removals += group.removals;
    for (const detail of group.details) {
      fileKeys.add(detail.path ?? detail.id);
    }
  }
  const summary = formatChangedFileSummary({
    count: fileKeys.size,
    prefix: "Edited",
    additions,
    removals,
  });
  return groups.length > 1 ? `${summary} · ${groups.length} turns` : summary;
}
