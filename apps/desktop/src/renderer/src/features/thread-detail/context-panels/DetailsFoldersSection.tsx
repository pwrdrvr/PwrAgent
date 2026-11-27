import { memo, useId, useMemo, useState, type ReactNode } from "react";
import { findPrimaryThreadLinkedDirectory } from "@pwragent/shared/navigation-state";
import {
  pullRequestMatchesRepositoryKey,
  type NavigationThreadSummary,
  type PrSummary,
} from "@pwragent/shared/contracts/navigation";
import type {
  ThreadWorkspaceHandoffDirection,
  WorktreeSnapshotSummary,
} from "@pwragent/shared/contracts/normalized-app-server";
import {
  BranchIcon,
  EditsIcon,
  FolderIcon,
  FolderPlusIcon,
  WorktreeIcon,
} from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { copyText } from "../../../lib/copy-text";
import type { NavigationDirectoryView } from "../../../lib/navigation-loaded-rows";
import { PrChip } from "../../pr-status/PrChip";
import { REMOTE_NATIVE_PICKER_TOOLTIP } from "../../composer/native-picker-boundary";
import { ProjectPicker } from "../../composer/ProjectPicker";
import {
  formatWorkspaceHandoffDirection,
  primaryWorkspacePullRequests,
} from "../../composer/thread-workspace";
import {
  CopyValueButton,
  TooltipValue,
  formatTimestamp,
  handleCopyPath,
  pathBaseName,
  type HideRailTooltip,
  type ShowRailTooltip,
} from "./context-rail-shared";
import { DetailsRowMenu, type DetailsRowMenuEntry } from "./DetailsRowMenu";
import { openExternalUrl } from "../../../lib/open-external-url";
import { useWorktreeStorageSession, WorktreeStorageDialog } from "../WorktreeStorageDialog";

type LinkedDirectory = NavigationThreadSummary["linkedDirectories"][number];

export type DetailsFoldersHandoff = {
  directions: readonly ThreadWorkspaceHandoffDirection[];
  /** Why the handoffs cannot run now: a turn is running, say. */
  disabled: boolean;
  onRequest: (direction: ThreadWorkspaceHandoffDirection) => void;
};

type DetailsFoldersSectionProps = {
  desktopApi?: Pick<
    DesktopApi,
    | "attachDirectoryToThread"
    | "detachDirectoryFromThread"
    | "onSettingsRuntimeChanged"
    | "pickDirectoryFromDisk"
    | "readWorktreeReflinkCapabilities"
    | "runWorktreeReflink"
  >;
  onRefreshNavigation?: () => Promise<void>;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string,
  ) => Promise<void>;
  thread: NavigationThreadSummary;
  worktreeArchiveError?: string;
  showTooltip: ShowRailTooltip;
  hideTooltip: HideRailTooltip;
  /** The primary folder's handoffs, from the composer's Worktree menu. */
  handoff?: DetailsFoldersHandoff;
  /** Opens the Changes segment. */
  onShowChanges?: () => void;
  /** Opens the PRs segment. */
  onShowPullRequests?: () => void;
  /** The primary folder's Auto-fix control, beside its PR. */
  autoFix?: ReactNode;
  onPortaledInteractionChange?: (open: boolean) => void;
  /** Tracked projects, which Attach folder offers before the disk picker. */
  trackedDirectories?: readonly NavigationDirectoryView[];
};

/**
 * Details › Thread › Folders & git. The primary folder leads, with the git
 * rows for whichever folder is selected: its branch, its changes, its PRs.
 * Attached folders sit below a rule, and choosing one points the git rows at
 * it. Each folder's ⋯ holds what used to be spread over the composer's
 * Worktree menu and the Linked projects tab: handoffs, Share storage,
 * snapshots, Copy path and Detach.
 */
export const DetailsFoldersSection = memo(function DetailsFoldersSection(props: DetailsFoldersSectionProps) {
  const headingId = useId();
  const [attachError, setAttachError] = useState<string>();
  const [attaching, setAttaching] = useState(false);
  const [detachError, setDetachError] = useState<string>();
  const [detachingDirectoryId, setDetachingDirectoryId] = useState<string>();
  // Kept by identity: the rail renders on every streamed delta, and a fresh
  // list would refilter every tracked project for Attach folder each time.
  const directories = useMemo(
    () => dedupeLinkedProjectDirectories(props.thread.linkedDirectories),
    [props.thread.linkedDirectories],
  );
  const resolvedPrimary = findPrimaryThreadLinkedDirectory(directories, props.thread.projectKey);
  // Drawn first even when the thread's cwd names none of its folders.
  const primaryDirectory = resolvedPrimary ?? directories[0];
  const attachedDirectories = directories.filter((directory) => directory !== primaryDirectory);
  const canAttachDirectory = Boolean(
    props.desktopApi?.pickDirectoryFromDisk && props.desktopApi.attachDirectoryToThread,
  );
  const nativePickingDisabled = Boolean(props.thread.federation?.ref.target);
  // This section outlives a thread switch, so per-thread choices name their thread.
  const threadKey = `${props.thread.source}\0${props.thread.id}`;
  const [storageFor, setStorageFor] = useState<{ thread: string; directory: string }>();
  // Forgotten on the way out, so coming back to the thread does not reopen it.
  if (storageFor && storageFor.thread !== threadKey) setStorageFor(undefined);
  const [gitTargetFor, setGitTargetFor] = useState<{ thread: string; directory: string }>();
  const gitTarget = gitTargetFor?.thread === threadKey
    ? directories.find((directory) => directory.id === gitTargetFor.directory) ?? primaryDirectory
    : primaryDirectory;
  // Git shares a linked worktree with its source checkout, on this machine.
  // One worktree stands in for the probe: the answer describes the selected
  // Git, not the directory, and the action is offered only once Git's own
  // help has listed the command.
  const storageApi = props.desktopApi?.readWorktreeReflinkCapabilities
    && props.desktopApi.runWorktreeReflink
    && !props.thread.federation?.ref.target
    ? props.desktopApi
    : undefined;
  const probeWorktree = storageApi
    ? directories.find((directory) => directory.kind === "worktree")
    : undefined;
  const probePath = probeWorktree ? probeWorktree.worktreePath ?? probeWorktree.path : undefined;
  const probeTarget = useMemo(
    () => (probePath
      ? { backend: props.thread.source, threadId: props.thread.id, worktreePath: probePath }
      : undefined),
    [probePath, props.thread.id, props.thread.source],
  );
  const storage = useWorktreeStorageSession(storageApi, probeTarget);
  const canShareStorage = storage.state.runtime?.capabilities.reflink === true;
  const storageDirectory = storageApi && canShareStorage
    && storageFor?.thread === threadKey
    ? directories.find((directory) => directory.id === storageFor.directory && directory.kind === "worktree")
    : undefined;
  const restorableSnapshots = (props.thread.worktreeSnapshots ?? []).filter(isRestorableSnapshot);

  // The projects Attach folder offers: tracked ones this thread has not linked.
  const attachableDirectories = useMemo(
    () => listAttachableDirectories(props.trackedDirectories ?? [], directories),
    [directories, props.trackedDirectories],
  );
  // `path` names a tracked project; without it the operator picks from disk.
  const attachDirectory = async (path?: string): Promise<void> => {
    if (nativePickingDisabled) {
      return;
    }
    if (!props.desktopApi?.pickDirectoryFromDisk || !props.desktopApi.attachDirectoryToThread) {
      return;
    }
    setAttachError(undefined);
    setDetachError(undefined);
    setAttaching(true);
    try {
      let attachPath = path;
      if (attachPath === undefined) {
        const picked = await props.desktopApi.pickDirectoryFromDisk();
        if (picked.canceled) {
          return;
        }
        attachPath = picked.path;
      }
      const attached = await props.desktopApi.attachDirectoryToThread({
        backend: props.thread.source,
        threadId: props.thread.id,
        path: attachPath,
        preferredBackend: props.thread.source,
      });
      if (!attached.ok) {
        setAttachError(attached.message);
        return;
      }
      await props.onRefreshNavigation?.();
    } finally {
      setAttaching(false);
    }
  };
  const detachDirectory = async (directory: LinkedDirectory): Promise<void> => {
    if (!props.desktopApi?.detachDirectoryFromThread) {
      return;
    }
    setAttachError(undefined);
    setDetachError(undefined);
    setDetachingDirectoryId(directory.id);
    try {
      const detached = await props.desktopApi.detachDirectoryFromThread({
        backend: props.thread.federation?.ref.backend ?? props.thread.source,
        federationTarget: props.thread.federation?.ref.target,
        threadId: props.thread.federation?.ref.threadId ?? props.thread.id,
        directory,
      });
      if (!detached.ok) {
        setDetachError(detached.message);
        return;
      }
      await props.onRefreshNavigation?.();
    } catch (error) {
      const details = error instanceof Error && error.message ? ` ${error.message}` : "";
      setDetachError(`Could not update linked folders.${details}`);
    } finally {
      setDetachingDirectoryId(undefined);
    }
  };

  const folderMenu = (directory: LinkedDirectory, primary: boolean): DetailsRowMenuEntry[] => {
    const checkout = directory.worktreePath ?? directory.path;
    const entries: DetailsRowMenuEntry[] = [];
    if (primary && props.handoff) {
      const handoff = props.handoff;
      for (const direction of handoff.directions) {
        entries.push({
          kind: "item",
          key: `handoff:${direction}`,
          label: formatWorkspaceHandoffDirection(direction),
          disabled: handoff.disabled,
          onSelect: () => handoff.onRequest(direction),
        });
      }
    }
    if (canShareStorage && directory.kind === "worktree") {
      if (entries.length > 0) entries.push({ kind: "separator", key: "storage-separator" });
      entries.push({
        kind: "item",
        key: "share-storage",
        label: "Share storage",
        onSelect: () => setStorageFor({ thread: threadKey, directory: directory.id }),
      });
    }
    if (primary && restorableSnapshots.length > 0) {
      entries.push({ kind: "heading", key: "snapshots", label: "Worktree snapshots" });
      for (const snapshot of restorableSnapshots) {
        entries.push({
          kind: "item",
          key: `restore:${snapshot.id}`,
          label: `Restore ${pathBaseName(snapshot.worktreePath)}`,
          detail: describeSnapshot(snapshot),
          disabled: !props.onRestoreWorktree,
          onSelect: () => {
            void props.onRestoreWorktree?.(props.thread, snapshot.snapshotRef, snapshot.worktreePath);
          },
        });
      }
    }
    if (entries.length > 0) entries.push({ kind: "separator", key: "copy-separator" });
    entries.push({
      kind: "item",
      key: "copy-path",
      label: "Copy path",
      detail: checkout,
      onSelect: () => { void copyText(checkout); },
    });
    // The folder the thread works in stays; so does a thread's only folder.
    if (props.desktopApi?.detachDirectoryFromThread
      && directories.length > 1
      && directory !== resolvedPrimary) {
      const detaching = detachingDirectoryId === directory.id;
      entries.push({
        kind: "item",
        key: "detach",
        label: detaching ? "Detaching" : "Detach",
        danger: true,
        disabled: detaching,
        onSelect: () => { void detachDirectory(directory); },
      });
    }
    return entries;
  };

  const renderFolder = (directory: LinkedDirectory, primary: boolean) => {
    const checkout = directory.worktreePath ?? directory.path;
    const selected = directory === gitTarget;
    const Icon = directory.kind === "worktree" ? WorktreeIcon : FolderIcon;
    return (
      <li key={directory.id} className={`details-row details-row--folder${primary ? " details-row--primary" : ""}${
        selected && directories.length > 1 ? " is-selected" : ""}`}>
        <Icon size={14} aria-hidden="true" className="details-row__icon" />
        <span className="details-row__text">
          {directories.length > 1 ? (
            <button
              type="button"
              className="details-row__title details-row__title-button"
              aria-pressed={selected}
              aria-label={`Show git for ${directory.label}`}
              onClick={() => setGitTargetFor({ thread: threadKey, directory: directory.id })}
            >
              {directory.label}
            </button>
          ) : (
            <span className="details-row__title">{directory.label}</span>
          )}
          <TooltipValue
            label={`Path for ${directory.label}`}
            value={checkout}
            onBlur={props.hideTooltip}
            onShowTooltip={props.showTooltip}
          >
            <small className="details-row__subtitle">{checkout}</small>
          </TooltipValue>
        </span>
        <span className={`details-row__badge${directory.kind === "worktree" && primary ? " details-row__badge--accent" : ""}`}>
          {!primary ? "attached" : directory.kind === "worktree" ? "worktree" : "local"}
        </span>
        <DetailsRowMenu
          label={`Folder actions for ${directory.label}`}
          entries={folderMenu(directory, primary)}
          onOpenChange={props.onPortaledInteractionChange}
        />
      </li>
    );
  };

  const branch = gitTarget
    ? gitTarget.gitBranch ?? (gitTarget === primaryDirectory ? props.thread.gitBranch : undefined)
    : props.thread.gitBranch;
  const targetPrs = gitTarget === primaryDirectory
    ? primaryFolderPullRequests(props.thread)
    : (props.thread.prs ?? []).filter((pr) => pullRequestMatchesRepositoryKey(pr, gitTarget?.repositoryKey));
  const workingState = gitTarget === primaryDirectory ? props.thread.gitWorkingState : undefined;
  const hasRecordedDirectory = directories.length === 0 && Boolean(props.thread.projectKey?.trim());

  if (directories.length === 0 && !hasRecordedDirectory && !canAttachDirectory) {
    return null;
  }

  return (
    <section className="context-panel__section details-section" aria-labelledby={headingId}
      data-details-section="folders">
      <h3 id={headingId} className="details-section__heading">Folders &amp; git</h3>
      {attachError ? (
        <p className="context-empty context-empty--warning">{attachError}</p>
      ) : null}
      {detachError ? (
        <p className="context-empty context-empty--error" role="alert">{detachError}</p>
      ) : null}
      {primaryDirectory ? (
        <ul className="details-rows" aria-label="Primary folder">
          {renderFolder(primaryDirectory, true)}
        </ul>
      ) : hasRecordedDirectory ? (
        <ul className="details-rows" aria-label="Primary folder">
          <li className="details-row details-row--folder details-row--primary">
            <FolderIcon size={14} aria-hidden="true" className="details-row__icon" />
            <span className="details-row__text">
              <span className="details-row__title">{pathBaseName(props.thread.projectKey!)}</span>
              <TooltipValue
                label="Recorded working directory path"
                value={props.thread.projectKey!}
                onBlur={props.hideTooltip}
                onShowTooltip={props.showTooltip}
              >
                <small className="details-row__subtitle">{props.thread.projectKey}</small>
              </TooltipValue>
            </span>
            {/* Nothing here stats the path: an empty `linkedDirectories`
                means no project was resolved, which is not the same as the
                directory being gone. */}
            <span className="details-row__badge">not linked</span>
            <CopyValueButton
              label="Copy recorded working directory"
              value={props.thread.projectKey!}
              onBlur={props.hideTooltip}
              onCopy={handleCopyPath}
              onShowTooltip={props.showTooltip}
            />
          </li>
        </ul>
      ) : null}
      {gitTarget || hasRecordedDirectory ? (
        <ul className="details-rows details-rows--git" aria-label={gitTarget ? `Git for ${gitTarget.label}` : "Git"}>
          {branch ? (
            <li className="details-row">
              <BranchIcon size={14} aria-hidden="true" className="details-row__icon" />
              <span className="details-row__text">
                <span className="details-row__title details-row__mono">{branch}</span>
              </span>
              <CopyValueButton
                label="Copy branch name"
                value={branch}
                onBlur={props.hideTooltip}
                onCopy={handleCopyPath}
                onShowTooltip={props.showTooltip}
              />
            </li>
          ) : null}
          {gitTarget === primaryDirectory && props.onShowChanges ? (
            <li className="details-row">
              <button type="button" className="details-row__action" onClick={props.onShowChanges}>
                <EditsIcon size={14} aria-hidden="true" className="details-row__icon" />
                <span className="details-row__text">
                  <span className="details-row__title">
                    Changes
                    {workingState?.baseBranch ? (
                      <span className="details-row__muted"> vs {workingState.baseBranch}</span>
                    ) : null}
                  </span>
                </span>
                {workingState ? <WorkingStateMeta state={workingState} /> : null}
              </button>
            </li>
          ) : null}
          {targetPrs.map((pr, index) => (
            <li key={`${pr.provider}/${pr.org}/${pr.repo}#${pr.number}`} className="details-row details-row--pr">
              <PrChip pr={pr} showRepoPrefix={false} onOpen={openExternalUrl} />
              <span className="details-row__text">
                {props.onShowPullRequests ? (
                  <button type="button" className="details-row__title details-row__title-button"
                    aria-label={`Show #${pr.number} in PRs`}
                    onClick={props.onShowPullRequests}>
                    {pr.title?.trim() || `${pr.org}/${pr.repo}`}
                  </button>
                ) : (
                  <span className="details-row__title">{pr.title?.trim() || `${pr.org}/${pr.repo}`}</span>
                )}
              </span>
              {index === 0 && gitTarget === primaryDirectory ? props.autoFix : null}
            </li>
          ))}
        </ul>
      ) : null}
      {attachedDirectories.length > 0 ? (
        <>
          <div className="details-rule" role="separator" />
          <ul className="details-rows" aria-label="Attached folders">
            {attachedDirectories.map((directory) => renderFolder(directory, false))}
          </ul>
        </>
      ) : null}
      {canAttachDirectory && nativePickingDisabled ? (
        <button
          className="details-row details-row--add"
          data-tooltip={REMOTE_NATIVE_PICKER_TOOLTIP}
          disabled
          title={REMOTE_NATIVE_PICKER_TOOLTIP}
          type="button"
        >
          <FolderPlusIcon size={14} aria-hidden="true" className="details-row__icon" />
          <span className="details-row__title">Attach folder</span>
        </button>
      ) : canAttachDirectory ? (
        // The composer's project picker: tracked projects first, then
        // "Add directory…" for a folder PwrAgent does not track yet.
        <ProjectPicker
          directories={attachableDirectories}
          disabled={attaching}
          picking={attaching}
          portal
          trigger={{
            className: "details-row details-row--add",
            ariaLabel: "Attach folder",
            content: (
              <>
                <FolderPlusIcon size={14} aria-hidden="true" className="details-row__icon" />
                <span className="details-row__title">{attaching ? "Attaching" : "Attach folder"}</span>
              </>
            ),
          }}
          onOpenChange={props.onPortaledInteractionChange}
          onSelect={(directory) => {
            if (directory.path) void attachDirectory(directory.path);
          }}
          onPickFromDisk={() => { void attachDirectory(); }}
        />
      ) : null}
      {storageApi && storageDirectory ? (
        <WorktreeStorageDialog
          api={storageApi}
          label={storageDirectory.label}
          target={{
            backend: props.thread.source,
            threadId: props.thread.id,
            worktreePath: storageDirectory.worktreePath ?? storageDirectory.path,
          }}
          turnActive={props.thread.threadStatus === "active"}
          onClose={() => setStorageFor(undefined)}
        />
      ) : null}
      {props.worktreeArchiveError ? (
        <p className="context-empty context-empty--error">
          {props.worktreeArchiveError}
        </p>
      ) : null}
    </section>
  );
});

function WorkingStateMeta(props: { state: NonNullable<NavigationThreadSummary["gitWorkingState"]> }) {
  const { state } = props;
  const ahead = state.baseAheadCommitCount ?? 0;
  const dirty = state.dirtyAdditions > 0 || state.dirtyDeletions > 0;
  if (!dirty && ahead === 0 && state.untrackedFiles === 0) {
    return <span className="details-row__meta">clean</span>;
  }
  return (
    <span className="details-row__meta">
      {dirty ? (
        <span aria-label={`${state.dirtyAdditions} lines added and ${state.dirtyDeletions} removed, uncommitted`}>
          <span className="details-row__add">+{state.dirtyAdditions}</span>
          {" "}
          <span className="details-row__del">−{state.dirtyDeletions}</span>
        </span>
      ) : null}
      {ahead > 0 ? <span>{dirty ? " · " : ""}{ahead} ahead</span> : null}
    </span>
  );
}

/**
 * The PRs of the primary folder. A thread whose primary repository is not
 * known yet, or that has one folder, owns every PR attached to it.
 */
function primaryFolderPullRequests(thread: NavigationThreadSummary): PrSummary[] {
  const primary = primaryWorkspacePullRequests(thread);
  if (primary.length > 0) return primary;
  return thread.linkedDirectories.length <= 1 ? thread.prs ?? [] : [];
}

function describeSnapshot(snapshot: WorktreeSnapshotSummary): string {
  if (snapshot.state === "hibernated") {
    return snapshot.hibernatedAt ? `Hibernated ${formatTimestamp(snapshot.hibernatedAt)}` : "hibernated";
  }
  return snapshot.archivedAt ? formatTimestamp(snapshot.archivedAt) : "archived";
}

/** Snapshots whose checkout is gone and can come back from them. */
function isRestorableSnapshot(snapshot: WorktreeSnapshotSummary): boolean {
  return snapshot.state === "archived" || snapshot.state === "hibernated";
}

export function dedupeLinkedProjectDirectories(
  directories: NavigationThreadSummary["linkedDirectories"],
): NavigationThreadSummary["linkedDirectories"] {
  const seen = new Set<string>();
  const deduped: NavigationThreadSummary["linkedDirectories"] = [];
  for (const directory of directories) {
    const key = [
      directory.kind,
      normalizeLinkedProjectPath(directory.path),
      normalizeLinkedProjectPath(directory.worktreePath ?? ""),
    ].join("\0");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(directory);
  }
  return deduped;
}

function normalizeLinkedProjectPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

/**
 * Tracked projects a thread can still attach: each has a local path (a peer's
 * placeholder project has none here), and none is already one of the
 * thread's folders, as a source checkout or a worktree. Order is kept.
 */
export function listAttachableDirectories(
  tracked: readonly NavigationDirectoryView[],
  linked: readonly LinkedDirectory[],
): NavigationDirectoryView[] {
  const linkedPaths = new Set<string>();
  for (const directory of linked) {
    linkedPaths.add(directory.path);
    if (directory.worktreePath) linkedPaths.add(directory.worktreePath);
  }
  return tracked.filter((directory) => directory.path !== undefined
    && directory.localAvailability !== "unconfigured"
    && !linkedPaths.has(directory.path));
}
