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
  /**
   * Cheap identity of the group's {key + edited paths}, maintained as the
   * group is built so `useEditCommitStates` can tell a real change from a
   * re-render without re-serializing every group per delta. Absent on
   * hand-built groups; use `editGroupFileSetSignature` to read it.
   */
  pathsSignature?: string;
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
 * Identity of a file within a group: its path, falling back to the detail id
 * for a detail that carries none. This is what repeat edits merge on — and
 * what a file row must be keyed by. A live cumulative diff's detail ids are
 * positional over the diff's path-ordered sections
 * (`live-diff-<turn>-<n>`, see `extractLiveDiffActivityDetails`), so a newly
 * edited file that sorts earlier renumbers every row behind it; keying rows on
 * the id remounts each of them mid-turn, which reads as the panel blinking and
 * collapses any diff the operator had opened.
 */
export function editedFileKey(detail: AppServerThreadActivityDetail): string {
  return detail.path ?? detail.id;
}

/**
 * Live cumulative turn diffs (from `turn/diff/updated`) are built with
 * this id prefix — see `buildPendingDiffEntry` in ThreadView. When a
 * turn has one, it is authoritative for that turn (it already folds
 * repeat edits of the same file together), so per-item file-change
 * entries from the same turn are ignored to avoid double counting.
 */
const LIVE_CUMULATIVE_DIFF_ID_PREFIX = "live-diff-";

/**
 * Transcript entries at the tail that are re-folded on every delta instead of
 * being committed to the persistent fold. Streaming replaces the last few
 * entries in place — pending items resolve against the persisted replay, and
 * a refresh can rewrite the tail — so committing them on sight would
 * invalidate the fold on every delta. Everything older is folded once and
 * never read again.
 */
const REFOLDED_TAIL_ENTRIES = 32;

/**
 * Turn buckets kept in the fold, beyond which a turn's accumulated details are
 * released. Only `MAX_RETAINED_TURN_GROUPS` ever render, and turn order only
 * grows, so a bucket past this margin can never return to the rail — the
 * margin covers the live overlay's group sorting ahead of every folded one.
 */
const RETAINED_TURN_BUCKETS = MAX_RETAINED_TURN_GROUPS + 2;

type FoldedBucket = {
  key: string;
  orderIndex: number;
  turn?: AppServerThreadTurnMetadata;
  detailsByKey: Map<string, AppServerThreadActivityDetail>;
  cumulative?: AppServerThreadActivityEntry;
  /** Older than the render cap: stops accumulating, never renders again. */
  dropped: boolean;
  /** Bumped on every fold into this bucket; keys `cachedGroup`. */
  version: number;
  cachedGroup?: EditedFileGroup;
  cachedGroupVersion?: number;
};

/**
 * A bucket's un-committed contributions for one derivation pass: the re-folded
 * tail entries plus the live cumulative diff overlay.
 */
type PendingBucket = {
  key: string;
  turn?: AppServerThreadTurnMetadata;
  /**
   * Raw details in arrival order, replayed onto the folded map at render time
   * rather than pre-merged: `mergeFileDiffDetail` is order-sensitive (a delete
   * wins, an add sticks), so a pre-merged tail would not always agree with a
   * single pass over the whole transcript.
   */
  details: AppServerThreadActivityDetail[];
  cumulative?: AppServerThreadActivityEntry;
  live: boolean;
  /** Set when this bucket exists only in the tail / overlay. */
  orderIndex?: number;
};

/**
 * The last group resolved for a bucket that had pending contributions, with
 * the inputs it was built from. The tail is re-folded every pass, so without
 * this a settled group would get a fresh identity per delta and churn every
 * downstream memo — exactly what the fold exists to avoid.
 */
type PendingGroupCacheEntry = {
  version: number;
  cumulative?: AppServerThreadActivityEntry;
  details: readonly AppServerThreadActivityDetail[];
  live: boolean;
  turn?: AppServerThreadTurnMetadata;
  group?: EditedFileGroup;
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
  const fileDiffRefs = (
    fileDiff: AppServerThreadActivityDetail["fileDiff"],
  ) => fileDiff?.diffRefs ?? (fileDiff?.diffRef ? [fileDiff.diffRef] : []);
  const diffRefs = [
    ...fileDiffRefs(existing.fileDiff),
    ...fileDiffRefs(detail.fileDiff),
  ];
  const omittedReason =
    detail.fileDiff.omittedReason ??
    existing.fileDiff.omittedReason;

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

/** The timestamp a fork boundary is measured against. */
function entryBoundaryTime(entry: AppServerThreadEntry): number | undefined {
  return typeof entry.createdAt === "number"
    ? entry.createdAt
    : typeof entry.turn?.completedAt === "number"
      ? entry.turn.completedAt
      : entry.turn?.startedAt;
}

/**
 * The bucket an entry contributes to, or `undefined` when it contributes
 * nothing. Shared by the committed fold and the re-folded tail so both classify
 * entries identically.
 */
function classifyEditEntry(entry: AppServerThreadEntry):
  | {
      key: string;
      turn?: AppServerThreadTurnMetadata;
      entry: AppServerThreadActivityEntry;
      cumulative: boolean;
    }
  | undefined {
  const turnKey = entry.turn?.id;
  if (entry.type !== "activity") {
    return undefined;
  }
  if (!entry.details.some((detail) => detail.fileDiff)) {
    return undefined;
  }
  return {
    key: turnKey ?? `entry:${entry.id}`,
    turn: entry.turn,
    entry,
    cumulative: entry.id.startsWith(LIVE_CUMULATIVE_DIFF_ID_PREFIX),
  };
}

/** FNV-1a, for the group file-set signature. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Cheap identity of a group's {key + edited paths}. `useEditCommitStates`
 * compares these to decide whether the git probes have to run again; hashing
 * keeps that comparison independent of how much diff text a group carries, so
 * a streaming delta doesn't re-serialize every retained group.
 */
export function computeEditGroupFileSetSignature(
  group: Pick<EditedFileGroup, "key" | "details">,
): string {
  const paths = new Set<string>();
  for (const detail of group.details) {
    const candidate = detail.path?.trim();
    if (candidate) {
      paths.add(candidate);
    }
  }
  const joined = [...paths].join("\n");
  return `${group.key}:${paths.size}:${joined.length}:${hashString(joined).toString(36)}`;
}

/**
 * The signature of a group's file set, preferring the one the collector
 * maintained as the group was built. Hand-built groups (tests, fixtures) fall
 * back to computing it.
 */
export function editGroupFileSetSignature(group: EditedFileGroup): string {
  return group.pathsSignature ?? computeEditGroupFileSetSignature(group);
}

/** Params for one edited-file-groups derivation pass. */
export type EditedFileGroupsInput = {
  entries: readonly AppServerThreadEntry[];
  activeTurnId?: string;
  forkCreatedAt?: number;
  livePendingEntry?: AppServerThreadActivityEntry;
};

/**
 * Stateful driver for the edited-file-groups derivation across a streaming
 * transcript. Callers keep one collector per mounted thread surface and feed
 * it every delta; see `createEditedFileGroupsCollector`.
 */
export type EditedFileGroupsCollector = {
  collect(input: EditedFileGroupsInput): EditedFileGroup[];
};

/**
 * Incremental driver for `collectEditedFileGroups`.
 *
 * `session.entries` gets a fresh array identity on every streamed transcript
 * delta while its entries stay put, so re-walking it per delta costs O(n) for
 * an append of one — O(n^2) across a turn, with a fresh result graph (and
 * stacked diff text) allocated each time. The collector instead folds each
 * entry exactly once and keeps the per-turn buckets, so an appended entry
 * costs work proportional to that entry.
 *
 * Reuse is validated, not assumed: the fold is kept only while the array still
 * starts with the same entry object and still carries the same object at the
 * fold's last committed position. Any wholesale replacement — a fresh read, a
 * different thread — fails that check and recomputes from scratch. The last
 * `REFOLDED_TAIL_ENTRIES` are never committed, so ordinary tail churn (pending
 * entries resolving, a live cumulative diff landing) stays on the fast path.
 *
 * Groups keep their object identity while their bucket is unchanged, so a
 * delta that touches one turn does not churn the other groups' rows.
 */
export function createEditedFileGroupsCollector(): EditedFileGroupsCollector {
  let turnOrder: string[] = [];
  let buckets = new Map<string, FoldedBucket>();
  /** Entries committed to the fold — the length of the validated prefix. */
  let foldedCount = 0;
  let headEntry: AppServerThreadEntry | undefined;
  let anchorEntry: AppServerThreadEntry | undefined;
  let foldedForkCreatedAt: number | undefined;
  let pastForkBoundary = true;
  /** Highest order index released from the fold; older buckets never render. */
  let droppedThrough = -1;
  let pendingGroupCache = new Map<string, PendingGroupCacheEntry>();
  let lastGroups: EditedFileGroup[] = [];

  const reset = (forkCreatedAt: number | undefined): void => {
    turnOrder = [];
    buckets = new Map();
    foldedCount = 0;
    headEntry = undefined;
    anchorEntry = undefined;
    foldedForkCreatedAt = forkCreatedAt;
    pastForkBoundary = typeof forkCreatedAt !== "number";
    droppedThrough = -1;
    pendingGroupCache = new Map();
  };

  const ensureBucket = (
    key: string,
    turn: AppServerThreadTurnMetadata | undefined,
  ): FoldedBucket => {
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        key,
        orderIndex: turnOrder.length,
        turn,
        detailsByKey: new Map(),
        cumulative: undefined,
        dropped: false,
        version: 0,
      };
      turnOrder.push(key);
      buckets.set(key, bucket);
    } else if (!bucket.turn && turn) {
      bucket.turn = turn;
      bucket.version += 1;
    }
    return bucket;
  };

  /** Release turns that can never render again, with their stacked diffs. */
  const dropStaleBuckets = (): void => {
    const threshold = turnOrder.length - RETAINED_TURN_BUCKETS;
    while (droppedThrough < threshold - 1) {
      droppedThrough += 1;
      const bucket = buckets.get(turnOrder[droppedThrough]);
      if (bucket && !bucket.dropped) {
        bucket.dropped = true;
        bucket.detailsByKey = new Map();
        bucket.cumulative = undefined;
        bucket.cachedGroup = undefined;
      }
    }
  };

  const foldEntry = (entry: AppServerThreadEntry): void => {
    if (typeof foldedForkCreatedAt === "number" && !pastForkBoundary) {
      // Forked Codex threads replay ancestor entries before their own turns.
      // Start the edit history at the fork thread's creation boundary.
      const entryCreatedAt = entryBoundaryTime(entry);
      if (
        typeof entryCreatedAt !== "number"
        || entryCreatedAt < foldedForkCreatedAt
      ) {
        return;
      }
      pastForkBoundary = true;
    }

    const classified = classifyEditEntry(entry);
    if (!classified) {
      return;
    }

    const bucket = ensureBucket(classified.key, classified.turn);
    if (bucket.dropped) {
      return;
    }
    bucket.version += 1;

    if (classified.cumulative) {
      bucket.cumulative = classified.entry;
      return;
    }

    for (const detail of classified.entry.details) {
      if (!detail.fileDiff) {
        continue;
      }
      const detailKey = editedFileKey(detail);
      bucket.detailsByKey.set(
        detailKey,
        mergeFileDiffDetail(bucket.detailsByKey.get(detailKey), detail),
      );
    }
  };

  const buildGroup = (params: {
    key: string;
    turn?: AppServerThreadTurnMetadata;
    details: AppServerThreadActivityDetail[];
    live: boolean;
  }): EditedFileGroup => {
    let additions = 0;
    let removals = 0;
    for (const detail of params.details) {
      additions += detail.fileDiff?.additions ?? 0;
      removals += detail.fileDiff?.removals ?? 0;
    }
    return {
      key: params.key,
      turn: params.turn,
      details: params.details,
      // Count only — the +/- stats render via the shared colored DiffStat
      // chip in the header (consistent with the thread-row dirty chip),
      // not as plain comma-separated text.
      summary: formatChangedFileCount({
        count: params.details.length,
        prefix: "Edited",
      }),
      additions,
      removals,
      live: params.live,
      pathsSignature: computeEditGroupFileSetSignature({
        key: params.key,
        details: params.details,
      }),
    };
  };

  const sameDetails = (
    left: readonly AppServerThreadActivityDetail[],
    right: readonly AppServerThreadActivityDetail[],
  ): boolean =>
    left.length === right.length
    && left.every((detail, index) => detail === right[index]);

  /** The rendered group for one bucket, folding in its pending contributions. */
  const resolveGroup = (
    bucket: FoldedBucket | undefined,
    pending: PendingBucket | undefined,
    nextPendingGroupCache: Map<string, PendingGroupCacheEntry>,
  ): EditedFileGroup | undefined => {
    if (!pending && bucket) {
      if (bucket.dropped) {
        return undefined;
      }
      if (bucket.cachedGroup && bucket.cachedGroupVersion === bucket.version) {
        return bucket.cachedGroup;
      }
    }

    const turn = bucket?.turn ?? pending?.turn;
    if (pending) {
      const cached = pendingGroupCache.get(pending.key);
      if (
        cached
        && cached.version === (bucket?.version ?? -1)
        && cached.cumulative === pending.cumulative
        && cached.live === pending.live
        && cached.turn === turn
        && sameDetails(cached.details, pending.details)
      ) {
        nextPendingGroupCache.set(pending.key, cached);
        return cached.group;
      }
    }

    const cumulative = pending?.cumulative ?? bucket?.cumulative;
    let details: AppServerThreadActivityDetail[];
    if (cumulative) {
      details = cumulative.details.filter((detail) => detail.fileDiff);
    } else {
      const detailsByKey = pending?.details.length
        ? new Map(bucket?.detailsByKey)
        : bucket?.detailsByKey;
      if (pending?.details.length && detailsByKey) {
        for (const detail of pending.details) {
          const detailKey = editedFileKey(detail);
          detailsByKey.set(
            detailKey,
            mergeFileDiffDetail(detailsByKey.get(detailKey), detail),
          );
        }
      }
      details = detailsByKey ? [...detailsByKey.values()] : [];
    }

    const group =
      details.length === 0
        ? undefined
        : buildGroup({
            key: bucket?.key ?? pending?.key ?? "",
            turn,
            details,
            live: pending?.live ?? false,
          });

    if (pending) {
      nextPendingGroupCache.set(pending.key, {
        version: bucket?.version ?? -1,
        cumulative: pending.cumulative,
        details: pending.details,
        live: pending.live,
        turn,
        group,
      });
    } else if (bucket && group) {
      bucket.cachedGroup = group;
      bucket.cachedGroupVersion = bucket.version;
    }
    return group;
  };

  return {
    collect(input) {
      const entries = input.entries;

      // The fold is only reusable while the array it was built from still
      // starts and ends (at the committed boundary) with the same entries.
      // Both anchors are needed: the tail anchor alone would survive a fresh
      // read of a different thread that happens to be shorter, and the head
      // alone would survive a truncation. What the anchors cannot see is an
      // entry rewritten in the middle of the committed prefix while both ends
      // hold — but a rewrite reaches the renderer through a fresh read, which
      // replaces every entry object including the head, and anything within
      // `REFOLDED_TAIL_ENTRIES` of the end is re-folded regardless. A producer
      // that splices an older entry in place while preserving the first and
      // last folded ones would need to invalidate this fold explicitly.
      const reusable =
        foldedForkCreatedAt === input.forkCreatedAt
        && entries.length >= foldedCount
        && (foldedCount === 0
          || (entries[0] === headEntry && entries[foldedCount - 1] === anchorEntry));
      if (!reusable) {
        reset(input.forkCreatedAt);
      }

      const commitThrough = Math.max(
        foldedCount,
        entries.length - REFOLDED_TAIL_ENTRIES,
      );
      for (let index = foldedCount; index < commitThrough; index += 1) {
        foldEntry(entries[index]);
      }
      if (commitThrough > foldedCount) {
        foldedCount = commitThrough;
        headEntry = entries[0];
        anchorEntry = entries[foldedCount - 1];
        dropStaleBuckets();
      }

      // Re-folded tail: everything the fold has not committed, plus the live
      // cumulative diff overlay, held per pass so the fold stays untouched.
      const pendingByKey = new Map<string, PendingBucket>();
      const pendingOrder: string[] = [];
      let tailPastForkBoundary = pastForkBoundary;
      const ensurePending = (
        key: string,
        turn: AppServerThreadTurnMetadata | undefined,
      ): PendingBucket => {
        let pending = pendingByKey.get(key);
        if (!pending) {
          pending = { key, turn, details: [], live: false };
          if (!buckets.has(key)) {
            pending.orderIndex = turnOrder.length + pendingOrder.length;
            pendingOrder.push(key);
          }
          pendingByKey.set(key, pending);
        } else if (!pending.turn && turn) {
          pending.turn = turn;
        }
        return pending;
      };

      for (let index = foldedCount; index < entries.length; index += 1) {
        const entry = entries[index];
        if (typeof input.forkCreatedAt === "number" && !tailPastForkBoundary) {
          const entryCreatedAt = entryBoundaryTime(entry);
          if (
            typeof entryCreatedAt !== "number"
            || entryCreatedAt < input.forkCreatedAt
          ) {
            continue;
          }
          tailPastForkBoundary = true;
        }

        const classified = classifyEditEntry(entry);
        if (!classified) {
          continue;
        }
        if (buckets.get(classified.key)?.dropped) {
          continue;
        }
        const pending = ensurePending(classified.key, classified.turn);
        if (classified.cumulative) {
          pending.cumulative = classified.entry;
          pending.details = [];
          continue;
        }
        for (const detail of classified.entry.details) {
          if (detail.fileDiff) {
            pending.details.push(detail);
          }
        }
      }

      if (input.livePendingEntry) {
        const key =
          input.livePendingEntry.turn?.id ?? input.activeTurnId ?? "live-turn";
        const pending = ensurePending(key, input.livePendingEntry.turn);
        pending.cumulative = input.livePendingEntry;
        pending.details = [];
        pending.live = true;
      }

      // Newest-first, bounded so an uncommitted thread can't grow the rail
      // (and its stacked diffs) without limit. The live/active turn sorts
      // newest, so it is always kept.
      const groups: EditedFileGroup[] = [];
      const nextPendingGroupCache = new Map<string, PendingGroupCacheEntry>();
      for (
        let index = turnOrder.length + pendingOrder.length - 1;
        index >= 0 && groups.length < MAX_RETAINED_TURN_GROUPS;
        index -= 1
      ) {
        const key =
          index < turnOrder.length
            ? turnOrder[index]
            : pendingOrder[index - turnOrder.length];
        const bucket = buckets.get(key);
        if (bucket?.dropped) {
          // Order indexes only grow, so nothing older can render either.
          break;
        }
        const group = resolveGroup(
          bucket,
          pendingByKey.get(key),
          nextPendingGroupCache,
        );
        if (group) {
          groups.push(group);
        }
      }
      pendingGroupCache = nextPendingGroupCache;

      // Hand back the previous array when nothing moved, so a delta that
      // changes no edit does not invalidate a single downstream memo.
      if (
        groups.length === lastGroups.length
        && groups.every((group, index) => group === lastGroups[index])
      ) {
        return lastGroups;
      }
      lastGroups = groups;
      return groups;
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
 *
 * One-shot: every call re-walks the whole transcript. A surface that
 * re-derives per streamed delta wants `createEditedFileGroupsCollector`,
 * which folds each entry once.
 */
export function collectEditedFileGroups(
  params: EditedFileGroupsInput,
): EditedFileGroup[] {
  return createEditedFileGroupsCollector().collect(params);
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
      const detailKey = editedFileKey(detail);
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
