import { useEffect, useRef, type CSSProperties } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { BranchIcon, FolderIcon, WorktreeIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { threadSummaryIdentityKey } from "../../lib/federated-thread-events";
import type { PendingLaunchpadCreation } from "../../lib/useThreadNavigation";
import { ThinkingScanner } from "../thread-detail/ThinkingScanner";

/**
 * A thread that has been submitted but does not exist yet, drawn in the row
 * slot the thread will take when it does.
 *
 * It is a thread row in everything but data: the same card, title line, and
 * chip flow, with the working scanner in the status lane and "Starting" where
 * the time goes. When the thread lands, its real row renders in this slot and
 * this one steps aside, so nothing moves.
 *
 * The scanner is the `ThinkingScanner` every working row uses, not a spinner
 * of its own: it pins each beam to one shared clock when it mounts, so any
 * number of starting and working rows sweep together without a React tick or
 * a root CSS variable per frame.
 *
 * Not draggable and not a drop target. Pin order and sub-thread order are
 * keyed by the backend's thread id, which does not exist until the thread
 * does.
 */
export function StartingThreadRow(props: {
  creation: PendingLaunchpadCreation;
  selected: boolean;
  /**
   * The Directories lens files the row under its project, so the location
   * chip is the worktree/local glyph alone — what the landed row shows there.
   */
  locationMode: "kind" | "label";
  compact?: boolean;
  nestedDepth?: number;
  onSelect?: (creation: PendingLaunchpadCreation) => void;
}) {
  const { creation } = props;
  const title = creation.title || "New thread";
  const worktree = creation.launchpad.workMode === "worktree";
  const branchName = creation.launchpad.branchName?.trim();
  const nested = props.nestedDepth !== undefined;
  const shellRef = useRef<HTMLDivElement>(null);
  // A selected starting row sits wherever its project or parent is, which can
  // be below the fold. Show it, as selecting a thread row does.
  useEffect(() => {
    if (props.selected) shellRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [props.selected]);
  return (
    <div
      ref={shellRef}
      className={`thread-row-shell thread-row-shell--starting${
        nested ? " thread-row-shell--nested" : ""
      }`}
      data-starting-thread={creation.selectionKey}
      role="listitem"
      style={
        nested && props.nestedDepth! > 1
          ? ({ "--thread-row-nested-depth": props.nestedDepth } as CSSProperties)
          : undefined
      }
    >
      <div
        className={`thread-row${props.compact ? " thread-row--compact" : ""}${
          props.selected ? " is-selected" : ""
        }`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          props.onSelect?.(creation);
        }}
      >
        <button
          aria-label={`${title}, starting in ${creation.directoryLabel}`}
          aria-pressed={props.selected}
          className="thread-row__open"
          type="button"
          onClick={() => props.onSelect?.(creation)}
        />
        <span className="thread-row__header">
          <span className="thread-row__heading">
            <span
              aria-label="Starting"
              className="thread-row__status-indicator thread-row__status-indicator--thinking"
              data-thread-status="starting"
              role="img"
              title="Starting"
            >
              <ThinkingScanner compact />
            </span>
            <span className="thread-row__title">{title}</span>
          </span>
          <span className="thread-row__time">Starting</span>
        </span>
        <span aria-hidden="true" className="thread-row__chips">
          <span className="thread-row__chip thread-row__chip--backend">
            {formatBackendLabel(creation.launchpad.backend)}
          </span>
          <span
            className={`thread-row__chip${
              props.locationMode === "kind" ? " thread-row__chip--location" : ""
            }`}
          >
            <span className="thread-row__chip-icon">
              {worktree ? <WorktreeIcon size={12} /> : <FolderIcon size={12} />}
            </span>
            {props.locationMode === "label" ? (
              <span className="thread-row__chip-label">{creation.directoryLabel}</span>
            ) : null}
          </span>
          {branchName ? (
            <span className="thread-row__chip thread-row__chip--mono">
              <span className="thread-row__chip-icon">
                <BranchIcon size={12} />
              </span>
              <span className="thread-row__chip-label">{branchName}</span>
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/**
 * Starting rows whose thread has not landed in this list yet. Once the real
 * row is here it holds the slot, and drawing both would show the thread twice.
 */
export function selectUnlandedStartingThreads(
  creations: readonly PendingLaunchpadCreation[] | undefined,
  renderedThreadKeys: { has: (threadKey: string) => boolean },
): PendingLaunchpadCreation[] {
  return (creations ?? []).filter(
    (creation) => !creation.threadKey || !renderedThreadKeys.has(creation.threadKey),
  );
}

export type StartingTrayEntry =
  | { kind: "thread"; thread: NavigationThreadSummary }
  | { kind: "starting"; creation: PendingLaunchpadCreation; depth: number };

/**
 * Interleave starting sub-threads into a tray where their threads will land.
 *
 * A sub-thread launchpad inserts its new child directly below the card that
 * opened it (`insertSubthreadIdAfter`): below the source child and its own
 * subtree, or at the top of the parent's children when the parent itself was
 * the source. `subtree` is the tray's depth-first rows and `depthOf` their
 * depth below `trayKey`.
 */
export function interleaveStartingSubthreads(params: {
  trayKey: string;
  subtree: readonly NavigationThreadSummary[];
  depthOf: (threadKey: string) => number;
  creations: readonly PendingLaunchpadCreation[];
}): StartingTrayEntry[] {
  const entries: StartingTrayEntry[] = params.subtree.map((thread) => ({ kind: "thread", thread }));
  const keyOf = (entry: StartingTrayEntry): string | undefined =>
    entry.kind === "thread" ? threadSummaryIdentityKey(entry.thread) : undefined;
  const depthOfEntry = (entry: StartingTrayEntry): number =>
    entry.kind === "thread" ? params.depthOf(threadSummaryIdentityKey(entry.thread)) : entry.depth;
  // Past `index` and every deeper row under it.
  const endOfSubtree = (index: number): number => {
    const depth = depthOfEntry(entries[index]!);
    let end = index + 1;
    while (end < entries.length && depthOfEntry(entries[end]!) > depth) end += 1;
    return end;
  };
  for (const creation of params.creations) {
    const parentKey = creation.parentThreadKey;
    if (!parentKey) continue;
    const parentIndex = parentKey === params.trayKey
      ? -1
      : entries.findIndex((entry) => keyOf(entry) === parentKey);
    if (parentKey !== params.trayKey && parentIndex < 0) continue;
    const depth = parentIndex < 0 ? 1 : depthOfEntry(entries[parentIndex]!) + 1;
    const sourceIndex = creation.sourceThreadKey && creation.sourceThreadKey !== parentKey
      ? entries.findIndex((entry, index) =>
        index > parentIndex && keyOf(entry) === creation.sourceThreadKey && depthOfEntry(entry) === depth)
      : -1;
    const at = sourceIndex >= 0 ? endOfSubtree(sourceIndex) : parentIndex + 1;
    entries.splice(at, 0, { kind: "starting", creation, depth });
  }
  return entries;
}
