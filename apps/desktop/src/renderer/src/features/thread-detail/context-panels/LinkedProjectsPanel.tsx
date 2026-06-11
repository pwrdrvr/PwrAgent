import type { NavigationThreadSummary } from "@pwragent/shared";
import { FolderIcon, WorktreeIcon } from "../../../icons";
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
  const directories = props.thread.linkedDirectories;
  const prs = props.thread.prs ?? [];
  const branch = props.thread.gitBranch;

  return (
    <section className="context-panel__section">
      <h3>Linked projects</h3>
      {directories.length > 0 ? (
        <ul className="context-list linked-projects-list">
          {directories.map((directory) => {
            const worktreePath = directory.worktreePath ?? directory.path;
            return (
              <li key={directory.id} className="linked-project">
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
                  <span className="pr-panel-row__repo">
                    {pr.provider}/{pr.org}/{pr.repo}
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
