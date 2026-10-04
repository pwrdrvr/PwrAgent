import { useCallback, useEffect, useRef, useSyncExternalStore, type CSSProperties } from "react";
import { BranchIcon, DraftIcon, FolderIcon, SubthreadIcon, WorktreeIcon } from "../../icons";
import { formatBackendLabel } from "../../lib/backend-label";
import { useRendererRecoveryState } from "../../lib/RendererRecoveryState";
import type { PendingLaunchpadCreation, SubthreadLaunchpadDraft } from "../../lib/useThreadNavigation";
import {
  isSubthreadLaunchpadDraft,
  pendingThreadTitleLine,
  StartingThreadRow,
  type PendingSidebarRow,
} from "./StartingThreadRow";

export const SUBTHREAD_DRAFT_UNTITLED = "New sub-thread";

/**
 * The launchpad's live draft. The composer writes the draft store on every
 * edit but persists `launchpad.prompt` only when it leaves the scope, so the
 * store is what follows the typing. Only this row subscribes, so a keystroke
 * re-renders one title, not the sidebar. Without a store (a standalone
 * render) the persisted prompt stands in.
 */
function useLaunchpadDraftText(draft: SubthreadLaunchpadDraft): string {
  const store = useRendererRecoveryState()?.composerDraftStore;
  const scopeKey = `launchpad:${draft.directoryKey}`;
  const subscribe = useCallback(
    (listener: () => void) => store?.subscribeDraft?.(scopeKey, listener) ?? (() => undefined),
    [scopeKey, store],
  );
  const getSnapshot = useCallback(
    () => store ? store.get(scopeKey)?.draft ?? "" : draft.launchpad.prompt,
    [draft.launchpad.prompt, scopeKey, store],
  );
  return useSyncExternalStore(subscribe, getSnapshot);
}

/**
 * A sub-thread still being written, drawn in the slot its thread will take:
 * directly under its parent, at the top of the parent's tray.
 *
 * It is the thread row's box outlined in the Draft chip's dashed neutral,
 * with the pencil in the status lane and "Draft" where the time goes. On send
 * the starting row takes the same slot, and its title is derived the same way,
 * so nothing moves or renames.
 *
 * Not draggable and not a drop target, for the starting row's reason: child
 * order is keyed by the backend's thread id, which does not exist yet.
 */
export function SubthreadDraftRow(props: {
  draft: SubthreadLaunchpadDraft;
  selected: boolean;
  /** As on `StartingThreadRow`: the Directories lens drops the label. */
  locationMode: "kind" | "label";
  compact?: boolean;
  nestedDepth?: number;
  /**
   * The row is filed away from its parent (the parent is not in this lens),
   * so it names the parent itself.
   */
  showParent?: boolean;
  onSelect?: (draft: SubthreadLaunchpadDraft) => void;
  onOpenContextMenu?: (
    draft: SubthreadLaunchpadDraft,
    position: { x: number; y: number },
  ) => void;
}) {
  const { draft } = props;
  const typedTitle = pendingThreadTitleLine(useLaunchpadDraftText(draft));
  const title = typedTitle || SUBTHREAD_DRAFT_UNTITLED;
  const parentTitle = draft.parentThreadTitle;
  const worktree = draft.launchpad.workMode === "worktree";
  const branchName = draft.launchpad.branchName?.trim();
  const nested = props.nestedDepth !== undefined;
  const shellRef = useRef<HTMLDivElement>(null);
  // Selected from the composer, the row can sit below the fold. Show it, as
  // selecting a thread row does.
  useEffect(() => {
    if (props.selected) shellRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [props.selected]);
  return (
    <div
      ref={shellRef}
      className={`thread-row-shell thread-row-shell--draft${
        nested ? " thread-row-shell--nested" : ""
      }`}
      data-subthread-draft={draft.selectionKey}
      role="listitem"
      style={
        nested && props.nestedDepth! > 1
          ? ({ "--thread-row-nested-depth": props.nestedDepth } as CSSProperties)
          : undefined
      }
    >
      <div
        className={`thread-row thread-row--draft${props.compact ? " thread-row--compact" : ""}${
          props.selected ? " is-selected" : ""
        }`}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("button")) return;
          props.onSelect?.(draft);
        }}
        onContextMenu={(event) => {
          if (!props.onOpenContextMenu) return;
          event.preventDefault();
          props.onOpenContextMenu(draft, { x: event.clientX, y: event.clientY });
        }}
      >
        <button
          aria-label={typedTitle
            ? `${typedTitle}, sub-thread draft under ${parentTitle}`
            : `New sub-thread draft, under ${parentTitle}`}
          aria-pressed={props.selected}
          className="thread-row__open"
          type="button"
          onClick={() => props.onSelect?.(draft)}
        />
        <span className="thread-row__header">
          <span className="thread-row__heading">
            <span
              aria-label="Draft"
              className="thread-row__status-indicator thread-row__status-indicator--draft"
              data-thread-status="draft"
              role="img"
              title="Draft"
            >
              <DraftIcon size={13} />
            </span>
            <span className="thread-row__title">{title}</span>
          </span>
          <span className="thread-row__time">Draft</span>
        </span>
        <span aria-hidden="true" className="thread-row__chips">
          <span className="thread-row__chip thread-row__chip--backend">
            {formatBackendLabel(draft.launchpad.backend)}
          </span>
          {worktree ? (
            <span className="thread-row__chip">
              <span className="thread-row__chip-icon">
                <WorktreeIcon size={12} />
              </span>
              <span className="thread-row__chip-label">New worktree</span>
            </span>
          ) : branchName ? (
            <span className="thread-row__chip thread-row__chip--mono">
              <span className="thread-row__chip-icon">
                <BranchIcon size={12} />
              </span>
              <span className="thread-row__chip-label">{branchName}</span>
            </span>
          ) : (
            <span
              className={`thread-row__chip${
                props.locationMode === "kind" ? " thread-row__chip--location" : ""
              }`}
            >
              <span className="thread-row__chip-icon">
                <FolderIcon size={12} />
              </span>
              {props.locationMode === "label" ? (
                <span className="thread-row__chip-label">{draft.directoryLabel}</span>
              ) : null}
            </span>
          )}
          {props.showParent ? (
            <span className="thread-row__chip thread-row__chip--subthread-parent" title={parentTitle}>
              <span className="thread-row__chip-icon">
                <SubthreadIcon size={12} />
              </span>
              <span className="thread-row__chip-label">{parentTitle}</span>
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

/**
 * The row for anything a list draws ahead of its thread: a sub-thread still
 * being written, or a thread still starting. Both take the slot the thread
 * will land in, so every list places them with one splice and draws them
 * through this one switch.
 */
export function PendingThreadRow(props: {
  entry: PendingSidebarRow;
  selected: boolean;
  locationMode: "kind" | "label";
  compact?: boolean;
  nestedDepth?: number;
  /** Filed away from its parent. Only a draft row says so; see `SubthreadDraftRow`. */
  showParent?: boolean;
  onSelect?: (entry: PendingSidebarRow) => void;
  onOpenSubthreadDraftContextMenu?: (
    draft: SubthreadLaunchpadDraft,
    position: { x: number; y: number },
  ) => void;
}) {
  if (isSubthreadLaunchpadDraft(props.entry)) {
    return (
      <SubthreadDraftRow
        compact={props.compact}
        draft={props.entry}
        locationMode={props.locationMode}
        nestedDepth={props.nestedDepth}
        selected={props.selected}
        showParent={props.showParent}
        onOpenContextMenu={props.onOpenSubthreadDraftContextMenu}
        onSelect={props.onSelect}
      />
    );
  }
  const creation: PendingLaunchpadCreation = props.entry;
  return (
    <StartingThreadRow
      compact={props.compact}
      creation={creation}
      locationMode={props.locationMode}
      nestedDepth={props.nestedDepth}
      selected={props.selected}
      onSelect={props.onSelect}
    />
  );
}
