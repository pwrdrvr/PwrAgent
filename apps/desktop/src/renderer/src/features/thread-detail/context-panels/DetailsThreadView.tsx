import { useId, useState, type ReactNode } from "react";
import type { BackendSummary } from "@pwragent/shared/contracts/backend";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import type { CodexEnvironmentActionRun } from "@pwragent/shared/contracts/normalized-app-server";
import type {
  DesktopApplicationDiscoveryCandidate,
  DesktopApplicationsSnapshot,
} from "@pwragent/shared/contracts/settings";
import { Select } from "../../../components/Select";
import { EditorIcon, PlayIcon, ServerIcon, SettingsIcon, TerminalIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import type { NavigationDirectoryView } from "../../../lib/navigation-loaded-rows";
import { readRendererFederationTarget } from "../../../lib/federation-window";
import { ipcErrorMessage } from "../../../lib/open-path-failure";
import {
  getThreadWorkspace,
  isThreadWorkspaceHandoffEligible,
  isWorkspaceHandoffAvailable,
  listWorkspaceHandoffDirections,
  type WorkspaceHandoffAvailability,
} from "../../composer/thread-workspace";
import type { ThreadWorkspaceHandoffDirection } from "@pwragent/shared/contracts/normalized-app-server";
import type { HideRailTooltip, ShowRailTooltip } from "./context-rail-shared";
import { DetailsAgentSection } from "./DetailsAgentSection";
import { DetailsAutoFixButton, type DetailsAutoFixSettings } from "./DetailsAutoFixButton";
import { DetailsFoldersSection } from "./DetailsFoldersSection";
import { DetailsRowMenu, type DetailsRowMenuEntry } from "./DetailsRowMenu";
import {
  deriveThreadEnvironmentModel,
  latestRunByAction,
  resolveEnvironmentActionId,
} from "./details-model";

/**
 * What the Thread view needs from the thread's window that the rail does not
 * hold itself: where the thread runs, the operator's applications, the
 * integrated terminal, and the composer's handoff dialog.
 */
export type DetailsThreadControls = {
  /** The machine the thread runs on, as the operator names it. */
  machineLabel: string;
  /** Set for a thread another instance owns. */
  peer?: { status?: string };
  applications?: DesktopApplicationsSnapshot;
  integratedTerminal?: {
    open: boolean;
    running?: boolean;
    disabledReason?: string;
    onToggle: () => void;
  };
  /** Opens the composer's handoff dialog; absent where it cannot. */
  onRequestWorkspaceHandoff?: (direction: ThreadWorkspaceHandoffDirection) => void;
  /** What the composer's handoff dialog would open now. */
  workspaceHandoffAvailability?: WorkspaceHandoffAvailability;
  /** The composer is busy with something a handoff must wait for. */
  workspaceHandoffBlocked?: boolean;
  workspaceActionsBlocked?: boolean;
  onEditEnvironments?: (workspacePath: string) => void;
  /** An environment setup is streaming for this thread. */
  environmentSetupRunning?: boolean;
  autoFix?: DetailsAutoFixSettings;
  /** Tracked projects, offered by Attach folder before the disk picker. */
  directories?: readonly NavigationDirectoryView[];
};

export type DetailsThreadViewProps = {
  thread: NavigationThreadSummary;
  backends: BackendSummary[];
  desktopApi?: DesktopApi;
  platform?: string;
  initialLoadDurationMs?: number;
  cost?: string;
  activeTurnId?: string;
  controls?: DetailsThreadControls;
  actionRuns: readonly CodexEnvironmentActionRun[];
  onStopEnvActionRun?: (run: CodexEnvironmentActionRun, mode: "stop" | "terminate") => void;
  onRefreshNavigation?: () => Promise<void>;
  onRestoreWorktree?: (
    thread: NavigationThreadSummary,
    snapshotRef: string,
    worktreePath: string,
  ) => Promise<void>;
  worktreeArchiveError?: string;
  onOpenToolOutputIncidentExplorer?: () => void;
  onShowChanges: () => void;
  onShowPullRequests: () => void;
  showTooltip: ShowRailTooltip;
  hideTooltip: HideRailTooltip;
  onPortaledInteractionChange?: (open: boolean) => void;
};

/**
 * Details › Thread: short sections of rows that each do something. Location
 * says where the thread runs and opens it there; Folders & git, Environment
 * and Agent follow. A section with nothing to show is left out.
 */
export function DetailsThreadView(props: DetailsThreadViewProps) {
  const { thread, controls } = props;
  const workspace = getThreadWorkspace(thread);
  const sourceBranch = thread.observedGitBranch ?? thread.gitBranch;
  const handoffDirections = controls?.onRequestWorkspaceHandoff
    && thread.workspaceHandoff?.available !== false
    ? listWorkspaceHandoffDirections(workspace).filter((direction) =>
      direction === "to-project" || isThreadWorkspaceHandoffEligible({ sourceBranch, threadWorkspace: workspace }))
    : [];
  const requestHandoff = controls?.onRequestWorkspaceHandoff;
  return (
    <>
      <DetailsLocationSection {...props} />
      <DetailsFoldersSection
        desktopApi={props.desktopApi}
        onRefreshNavigation={props.onRefreshNavigation}
        onRestoreWorktree={props.onRestoreWorktree}
        thread={thread}
        worktreeArchiveError={props.worktreeArchiveError}
        showTooltip={props.showTooltip}
        hideTooltip={props.hideTooltip}
        onShowChanges={props.onShowChanges}
        onShowPullRequests={props.onShowPullRequests}
        onPortaledInteractionChange={props.onPortaledInteractionChange}
        trackedDirectories={controls?.directories}
        handoff={requestHandoff && handoffDirections.length > 0 ? {
          directions: handoffDirections,
          // The composer answers the request and has the last word: a
          // queued send or a submit in flight refuses it there.
          isDisabled: (direction) => Boolean(
            props.activeTurnId || controls?.workspaceHandoffBlocked || controls?.workspaceActionsBlocked,
          ) || !isWorkspaceHandoffAvailable(controls?.workspaceHandoffAvailability, direction),
          onRequest: requestHandoff,
        } : undefined}
        autoFix={controls?.autoFix ? (
          <DetailsAutoFixButton
            thread={thread}
            desktopApi={props.desktopApi}
            settings={controls.autoFix}
            onOpenChange={props.onPortaledInteractionChange}
          />
        ) : undefined}
      />
      <DetailsEnvironmentSection {...props} />
      <DetailsAgentSection
        thread={thread}
        backends={props.backends}
        platform={props.platform}
        desktopApi={props.desktopApi}
        initialLoadDurationMs={props.initialLoadDurationMs}
        cost={props.cost}
        onOpenToolOutputIncidentExplorer={props.onOpenToolOutputIncidentExplorer}
        onRefreshNavigation={props.onRefreshNavigation}
        onPortaledInteractionChange={props.onPortaledInteractionChange}
      />
    </>
  );
}

function DetailsSection(props: { title: string; action?: ReactNode; children: ReactNode }) {
  const headingId = useId();
  return (
    <section className="context-panel__section details-section" aria-labelledby={headingId}>
      <div className="details-section__header">
        <h3 id={headingId} className="details-section__heading">{props.title}</h3>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}

function pickApplication(
  candidates: readonly DesktopApplicationDiscoveryCandidate[] | undefined,
  preferredId: string | undefined,
): DesktopApplicationDiscoveryCandidate | undefined {
  return candidates?.find((application) => application.canOpenWorkspace && application.id === preferredId)
    ?? candidates?.find((application) => application.canOpenWorkspace);
}

function DetailsLocationSection(props: DetailsThreadViewProps) {
  const { thread, controls } = props;
  const [openError, setOpenError] = useState<string>();
  const workspacePath = controls?.workspaceActionsBlocked
    ? undefined
    : getThreadWorkspace(thread)?.sourcePath;
  const applications = controls?.applications;
  const editor = pickApplication(applications?.editors, applications?.preferredEditorId.value);
  const openApi = props.desktopApi?.openApplication;
  const canOpen = Boolean(workspacePath && openApi);
  const openableApplications = canOpen
    ? [...applications?.editors ?? [], ...applications?.terminals ?? []]
      .filter((application) => application.canOpenWorkspace)
    : [];
  const openWith = async (application: DesktopApplicationDiscoveryCandidate): Promise<void> => {
    if (!openApi || !workspacePath) return;
    setOpenError(undefined);
    const federationTarget = thread.federation?.ref.target ?? readRendererFederationTarget();
    try {
      await openApi({
        applicationId: application.id,
        ...(federationTarget ? { federationTarget } : {}),
        kind: application.kind,
        targetPath: workspacePath,
      });
    } catch (error) {
      setOpenError(ipcErrorMessage(error));
    }
  };
  const terminal = controls?.integratedTerminal;
  // A peer's thread shows only what works there.
  const showTerminal = terminal && !terminal.disabledReason;
  const peer = controls?.peer;
  if (!controls) return null;
  const otherApplications: DetailsRowMenuEntry[] = openableApplications
    .filter((application) => application !== editor)
    .map((application) => ({
      kind: "item",
      key: `${application.kind}:${application.id}`,
      label: `Open in ${application.name}`,
      onSelect: () => { void openWith(application); },
    }));
  return (
    <DetailsSection title="Location">
      <ul className="details-rows">
        <li className="details-row">
          <ServerIcon size={14} aria-hidden="true" className="details-row__icon" />
          <span className="details-row__text">
            <span className="details-row__title">{controls.machineLabel}</span>
          </span>
          <span className="details-row__meta">
            {peer ? `peer${peer.status ? ` · ${peer.status}` : ""}` : "this machine"}
          </span>
        </li>
        {canOpen && editor ? (
          <li className="details-row details-row--split">
            <button type="button" className="details-row__action" onClick={() => { void openWith(editor); }}>
              <EditorIcon size={14} aria-hidden="true" className="details-row__icon" />
              <span className="details-row__title">Open in {editor.name}</span>
            </button>
            <DetailsRowMenu
              label="Open in another application"
              trigger="chevron"
              entries={otherApplications}
              onOpenChange={props.onPortaledInteractionChange}
            />
          </li>
        ) : null}
        {showTerminal ? (
          <li className="details-row">
            <button
              type="button"
              className="details-row__action"
              aria-pressed={terminal.open}
              onClick={terminal.onToggle}
            >
              <TerminalIcon size={14} aria-hidden="true" className="details-row__icon" />
              <span className="details-row__title">
                {peer ? `Terminal on ${controls.machineLabel}` : "Terminal"}
              </span>
              <span className="details-row__meta">
                {terminal.open ? "open" : terminal.running ? "running" : ""}
              </span>
            </button>
          </li>
        ) : null}
      </ul>
      {openError ? <p className="context-empty context-empty--error" role="alert">{openError}</p> : null}
    </DetailsSection>
  );
}

function DetailsEnvironmentSection(props: DetailsThreadViewProps) {
  const { thread, controls } = props;
  const [selecting, setSelecting] = useState<string>();
  const [starting, setStarting] = useState<string>();
  const [error, setError] = useState<string>();
  const model = deriveThreadEnvironmentModel(thread);
  const runs = latestRunByAction(props.actionRuns);
  const setEnvironment = props.desktopApi?.setCodexThreadEnvironment;
  const runAction = props.desktopApi?.runCodexEnvironmentAction;
  if (model.options.length === 0 && !thread.codexEnvironmentRuntime) return null;
  const federationTarget = thread.federation?.ref.target ?? readRendererFederationTarget();
  const busy = selecting !== undefined || controls?.environmentSetupRunning === true;
  const workspacePath = controls?.workspaceActionsBlocked ? undefined : getThreadWorkspace(thread)?.sourcePath;
  // Environments are edited on the machine that runs them.
  const editPath = controls?.onEditEnvironments
    && federationTarget?.scope !== "remote"
    && thread.codexEnvironmentRuntime?.executionTarget !== "remote"
    ? thread.codexEnvironmentRuntime?.cwd ?? workspacePath
    : undefined;
  const select = async (environmentId: string): Promise<void> => {
    if (!setEnvironment) return;
    const environment = model.options.find((option) => option.id === environmentId);
    setSelecting(environmentId);
    setError(undefined);
    try {
      await setEnvironment({
        backend: thread.source,
        federationTarget,
        threadId: thread.id,
        environmentId: environmentId || undefined,
        actionId: resolveEnvironmentActionId(
          environment,
          undefined,
          thread.codexEnvironmentRuntime?.selectedActionIdByEnvironmentId,
        ),
      });
      await props.onRefreshNavigation?.();
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      setSelecting(undefined);
    }
  };
  const run = async (actionId: string): Promise<void> => {
    if (!runAction) return;
    setStarting(actionId);
    setError(undefined);
    try {
      await runAction({
        backend: thread.source,
        federationTarget,
        threadId: thread.id,
        actionId,
        ...(workspacePath ? { cwd: workspacePath } : {}),
      });
      await props.onRefreshNavigation?.();
    } catch (reason) {
      setError(ipcErrorMessage(reason));
    } finally {
      setStarting(undefined);
    }
  };
  const onEdit = controls?.onEditEnvironments;
  return (
    <DetailsSection
      title="Environment"
      action={editPath && onEdit ? (
        <button
          type="button"
          className="details-row__more"
          aria-label="Edit environments"
          onClick={() => onEdit(editPath)}
        >
          <SettingsIcon size={13} aria-hidden="true" />
        </button>
      ) : undefined}
    >
      <Select
        aria-label="Environment"
        className="settings-select details-select"
        disabled={busy || !setEnvironment}
        value={selecting ?? model.selectedEnvironmentId ?? ""}
        options={[
          { value: "", label: "No environment" },
          ...model.options.map((environment) => ({
            value: environment.id,
            label: environment.name,
            ...(model.missingIds.has(environment.id)
              ? { description: "Not found in this workspace", disabled: true }
              : {}),
          })),
        ]}
        onChange={(value) => { void select(value); }}
      />
      {model.actions.length > 0 ? (
        <ul className="details-rows" aria-label="Environment commands">
          {model.actions.map((action) => {
            const latest = runs.get(action.id);
            const running = latest?.status === "started";
            const isStarting = starting === action.id;
            return (
              <li key={action.id} className="details-row">
                <button
                  type="button"
                  className={`details-row__run${running ? " is-running" : ""}`}
                  aria-label={`Run ${action.name}`}
                  aria-busy={isStarting || undefined}
                  disabled={isStarting || busy || !runAction || running}
                  onClick={() => { void run(action.id); }}
                >
                  <PlayIcon size={11} aria-hidden="true" />
                </button>
                <span className="details-row__text">
                  <span className="details-row__title">{action.name}</span>
                  <small className="details-row__subtitle">{action.command}</small>
                </span>
                <span className={`details-row__meta${running ? " details-row__meta--running" : latest?.status === "failed" ? " details-row__meta--failed" : ""}`}>
                  {isStarting ? "starting" : describeRun(latest)}
                </span>
                {latest && running && props.onStopEnvActionRun ? (
                  <button
                    type="button"
                    className="context-list__action"
                    aria-label={`Stop ${action.name}`}
                    disabled={latest.terminationMode !== undefined}
                    onClick={() => props.onStopEnvActionRun?.(latest, "stop")}
                  >
                    Stop
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {error ? <p className="context-empty context-empty--error" role="alert">{error}</p> : null}
    </DetailsSection>
  );
}

function describeRun(run: CodexEnvironmentActionRun | undefined): string {
  if (!run) return "";
  if (run.status === "started") return run.terminationMode ? "stopping" : "running";
  if (run.status === "failed") return run.exitCode !== undefined ? `failed · exit ${run.exitCode}` : "failed";
  return run.exitCode !== undefined && run.exitCode !== 0 ? `exit ${run.exitCode}` : "done";
}
