import { useState } from "react";
import type { NavigationThreadSummary } from "@pwragent/shared";
import { FolderIcon, WorktreeIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { PrChip } from "../../pr-status/PrChip";
import {
  CopyValueButton,
  TooltipValue,
  handleCopyPath,
  openExternalUrl,
  type HideRailTooltip,
  type ShowRailTooltip,
} from "./context-rail-shared";

type LinkedProjectsPanelProps = {
  desktopApi?: Pick<
    DesktopApi,
    "attachDirectoryToThread" | "detachDirectoryFromThread" | "pickDirectoryFromDisk"
  >;
  onRefreshNavigation?: () => Promise<void>;
  thread: NavigationThreadSummary;
  showTooltip: ShowRailTooltip;
  hideTooltip: HideRailTooltip;
};

/**
 * Linked Projects tab — the cross-repo view: every directory/worktree
 * this thread touches, the branch it's on, and the pull requests linked
 * to it. Worktree dirty/clean status is a placeholder pending a
 * main-process `git status --porcelain` IPC (see TODO below).
 */
export function LinkedProjectsPanel(props: LinkedProjectsPanelProps) {
  const [attachError, setAttachError] = useState<string>();
  const [attaching, setAttaching] = useState(false);
  const [detachError, setDetachError] = useState<string>();
  const [detachingDirectoryId, setDetachingDirectoryId] = useState<string>();
  const directories = dedupeLinkedProjectDirectories(props.thread.linkedDirectories);
  const prs = props.thread.prs ?? [];
  const branch = props.thread.gitBranch;
  const canAttachDirectory = Boolean(
    props.desktopApi?.pickDirectoryFromDisk && props.desktopApi.attachDirectoryToThread,
  );
  const attachDirectory = async (): Promise<void> => {
    if (!props.desktopApi?.pickDirectoryFromDisk || !props.desktopApi.attachDirectoryToThread) {
      return;
    }
    setAttachError(undefined);
    setDetachError(undefined);
    setAttaching(true);
    try {
      const picked = await props.desktopApi.pickDirectoryFromDisk();
      if (picked.canceled) {
        return;
      }
      const attached = await props.desktopApi.attachDirectoryToThread({
        backend: props.thread.source,
        threadId: props.thread.id,
        path: picked.path,
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
  const detachDirectory = async (
    directory: NavigationThreadSummary["linkedDirectories"][number],
  ): Promise<void> => {
    if (!props.desktopApi?.detachDirectoryFromThread) {
      return;
    }
    setAttachError(undefined);
    setDetachError(undefined);
    setDetachingDirectoryId(directory.id);
    try {
      const detached = await props.desktopApi.detachDirectoryFromThread({
        backend: props.thread.source,
        threadId: props.thread.id,
        directory,
      });
      if (!detached.ok) {
        setDetachError(detached.message);
        return;
      }
      await props.onRefreshNavigation?.();
    } finally {
      setDetachingDirectoryId(undefined);
    }
  };

  return (
    <section className="context-panel__section">
      <div className="linked-projects__header">
        <h3>Linked projects</h3>
        {canAttachDirectory ? (
          <button
            className="context-list__action"
            disabled={attaching}
            type="button"
            onClick={() => {
              void attachDirectory();
            }}
          >
            <FolderIcon size={13} aria-hidden="true" />
            {attaching ? "Adding" : "Add directory"}
          </button>
        ) : null}
      </div>
      {attachError ? (
        <p className="context-empty context-empty--warning">{attachError}</p>
      ) : null}
      {detachError ? (
        <p className="context-empty context-empty--warning">{detachError}</p>
      ) : null}
      {directories.length > 0 ? (
        <ul className="context-list linked-projects-list">
          {directories.map((directory, index) => {
            const worktreePath = directory.worktreePath ?? directory.path;
            const canDetachDirectory = Boolean(
              index > 0 && props.desktopApi?.detachDirectoryFromThread,
            );
            const detaching = detachingDirectoryId === directory.id;
            return (
              <li key={directory.id} className="linked-project">
                <div className="linked-project__heading">
                  <div className="context-list__label">
                    <CopyValueButton
                      label={`Copy path for ${directory.label}`}
                      value={worktreePath}
                      onBlur={props.hideTooltip}
                      onCopy={handleCopyPath}
                      onShowTooltip={props.showTooltip}
                    />
                    <TooltipValue
                      label={`Path for ${directory.label}`}
                      value={worktreePath}
                      onBlur={props.hideTooltip}
                      onShowTooltip={props.showTooltip}
                    >
                      <span aria-hidden="true" className="context-list__icon">
                        {directory.kind === "worktree" ? (
                          <WorktreeIcon size={14} />
                        ) : (
                          <FolderIcon size={14} />
                        )}
                      </span>
                      {directory.label}
                    </TooltipValue>
                  </div>
                  {canDetachDirectory ? (
                    <button
                      className="context-list__action context-list__action--danger"
                      disabled={detaching}
                      type="button"
                      onClick={() => {
                        void detachDirectory(directory);
                      }}
                    >
                      {detaching ? "Detaching" : "Detach"}
                    </button>
                  ) : null}
                </div>
                <dl className="linked-project__facts">
                  <div>
                    <dt>Kind</dt>
                    <dd>{directory.kind === "worktree" ? "Worktree" : "Directory"}</dd>
                  </div>
                  {branch ? (
                    <div>
                      <dt>Branch</dt>
                      <dd className="context-grid__mono">{branch}</dd>
                    </div>
                  ) : null}
                  {/* TODO(linked-projects): add a "Working tree" dirty/clean
                      row here once a main-process `git status --porcelain`
                      IPC exists. Omitted until then rather than shipping
                      placeholder copy (CLAUDE.md: no placeholder UI). */}
                </dl>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="context-empty">No linked projects.</p>
      )}

      {prs.length > 0 ? (
        <div className="linked-projects__prs">
          <h4 className="context-subheading">Linked pull requests</h4>
          <ul className="context-list pr-panel-list">
            {prs.map((pr) => (
              <li key={`${pr.provider}/${pr.org}/${pr.repo}#${pr.number}`} className="pr-panel-row">
                <div className="pr-panel-row__main">
                  <PrChip pr={pr} showRepoPrefix={false} onOpen={openExternalUrl} />
                  <span className="pr-panel-row__details">
                    {pr.title?.trim() ? (
                      <span className="pr-panel-row__title">{pr.title.trim()}</span>
                    ) : null}
                    <span className="pr-panel-row__repo">
                      {pr.provider}/{pr.org}/{pr.repo}
                    </span>
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function dedupeLinkedProjectDirectories(
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
