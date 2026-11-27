import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { DEFAULT_WATCH_MERGE_BUILDS } from "@pwragent/shared/contracts/settings";
import { projectWatchesMergeBuilds } from "@pwragent/shared/project-forge-automation";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { NavigationDirectoryView } from "../../../lib/navigation-loaded-rows";
import { describeAutoFixCoverage } from "../../composer/auto-fix-coverage";
import { ComposerPrMenu } from "../../composer/ComposerPrMenu";
import {
  describeEndedPullRequestAutoFix,
  getPrimaryWorkspaceRepository,
  primaryWorkspacePullRequests,
} from "../../composer/thread-workspace";
import {
  describeProjectAutoFixOverride,
  findThreadProjectDirectory,
} from "../../forge-automation/forge-automation-view";

/** The Settings and callbacks the composer's PR button reads, for the rail's. */
export type DetailsAutoFixSettings = {
  backgroundPrPollingEnabled?: boolean;
  prAutoDispatchAllowed?: boolean;
  /** `[git] watch_merge_builds`. */
  watchMergeBuildsDefault?: boolean;
  directories?: readonly NavigationDirectoryView[];
  onSetThreadPrAutoDispatch?: (enabled: boolean, prKey?: string) => Promise<void>;
};

/**
 * The PR row's Auto-fix control: the composer's PR automation menu, with the
 * same availability, project override and coverage, labelled in words. The
 * row beside it already names the PR.
 */
export function DetailsAutoFixButton(props: {
  thread: NavigationThreadSummary;
  desktopApi?: DesktopApi;
  settings: DetailsAutoFixSettings;
  onOpenChange?: (open: boolean) => void;
}) {
  const { thread, settings } = props;
  if (!getPrimaryWorkspaceRepository(thread)) return null;
  const backgroundPrPollingEnabled = settings.backgroundPrPollingEnabled ?? true;
  const prAutoDispatchAllowed = settings.prAutoDispatchAllowed ?? true;
  const available = backgroundPrPollingEnabled && prAutoDispatchAllowed;
  // A peer's thread is governed by its owner's projects, which this window
  // does not hold, so a local project of the same path must not claim it.
  const project = thread.federation
    ? undefined
    : findThreadProjectDirectory(thread, settings.directories);
  const projectOverride = project
    ? describeProjectAutoFixOverride(project.forgeAutomation, project.label)
    : undefined;
  const idleTooltip = thread.prAutoDispatchEnabled
    ? describeEndedPullRequestAutoFix(thread)
    : undefined;
  const projectMuted = available && projectOverride?.muted === true;
  const idle = available && !projectMuted && Boolean(idleTooltip);
  const tooltip = !backgroundPrPollingEnabled
    ? "Auto-fix PR paused — turn on background PR polling in Settings"
    : !prAutoDispatchAllowed
      ? "Auto-fix PR disabled globally — allow it in Git settings"
      : projectOverride?.muted
        ? projectOverride.tooltip
        : idleTooltip
          ?? projectOverride?.tooltip
          ?? "Auto-fix PR — starts a repair turn when a new push fails CI or hits a merge conflict. To hear about a pass or a re-run, ask the agent to watch CI.";
  const onSet = settings.onSetThreadPrAutoDispatch;
  return (
    <ComposerPrMenu
      thread={thread}
      desktopApi={props.desktopApi}
      watchMergeBuildsDefault={projectWatchesMergeBuilds(
        project?.forgeAutomation,
        settings.watchMergeBuildsDefault ?? DEFAULT_WATCH_MERGE_BUILDS,
      )}
      primaryPrs={primaryWorkspacePullRequests(thread)}
      className={`details-row__badge details-row__badge-button${
        thread.prAutoDispatchEnabled ? " is-active" : ""
      }${projectMuted ? " is-project-overridden" : ""}${idle ? " is-idle" : ""}`}
      ariaDescription={!available ? undefined : idle ? idleTooltip : projectOverride?.tooltip}
      tooltip={tooltip}
      triggerText={thread.prAutoDispatchEnabled ? "Auto-fix" : "Auto-fix off"}
      testId="details-pr-auto-fix"
      onOpenChange={props.onOpenChange}
      autoFix={{
        checked: Boolean(thread.prAutoDispatchEnabled),
        available,
        unavailableDetail: !backgroundPrPollingEnabled ? "PR polling is off" : "Not allowed in Git settings",
        onToggle: (enabled) => { void onSet?.(enabled); },
        coverage: describeAutoFixCoverage(thread, project?.forgeAutomation),
        // A peer that predates one PR's switch would toggle the thread.
        onTogglePr: onSet
          && (!thread.federation
            || thread.federation.capabilities?.includes("thread_pull_request_auto_fix_v1") === true)
          ? (prKey, enabled) => { void onSet(enabled, prKey); }
          : undefined,
      }}
    />
  );
}
