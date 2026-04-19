import { useEffect, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerThreadReplayPagination,
  AppServerSkillSummary,
  BackendSummary,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { Composer } from "../composer/Composer";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadHeader } from "./ThreadHeader";
import { TranscriptImageLightbox } from "./TranscriptImageLightbox";
import { TranscriptList } from "./TranscriptList";

function arePlanEntriesEquivalent(
  left: AppServerThreadPlanEntry,
  right: AppServerThreadPlanEntry
): boolean {
  if ((left.explanation ?? "").trim() !== (right.explanation ?? "").trim()) {
    return false;
  }

  if (left.steps.length !== right.steps.length) {
    return false;
  }

  return left.steps.every((step, index) => {
    const other = right.steps[index];
    return other?.status === step.status && other.step === step.step;
  });
}

type ThreadViewProps = {
  activeRunId?: string;
  addOptimisticUserMessage: (text: string) => string;
  backendError?: string;
  backends: BackendSummary[];
  clearPendingRequest: (requestId: string, nextStatus?: string) => void;
  composerDisabled: boolean;
  desktopApi?: DesktopApi;
  fetchedAt?: number;
  launchpadError?: string;
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  pendingAssistantMessage?: AppServerThreadMessageEntry;
  pendingRequest?: AppServerPendingRequestNotification;
  pendingStatusText?: string;
  platform?: string;
  selectedDirectory?: NavigationDirectorySummary;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
  setExecutionModeError?: string;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  transcriptEntries: AppServerThreadEntry[];
  transcriptError?: string;
  transcriptPagination?: AppServerThreadReplayPagination;
  updatingExecutionMode?: ThreadExecutionMode;
  onActiveRunIdChange?: (runId?: string) => void;
  onEnsureSkillsLoaded?: () => void | Promise<void>;
  onLoadOlder: () => Promise<void>;
  onMaterializeLaunchpad?: (
    directoryKey: string,
    input?: Array<{ type: "text"; text: string }>
  ) => Promise<void>;
  onPendingStatusChange?: (status?: string) => void;
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
  onUpdateLaunchpad?: (
    directoryKey: string,
    patch: Partial<
      Pick<
        NavigationLaunchpadDraft,
        | "prompt"
        | "backend"
        | "executionMode"
        | "model"
        | "reasoningEffort"
        | "serviceTier"
        | "fastMode"
        | "workMode"
        | "branchName"
        | "directoryLabel"
        | "directoryPath"
      >
    >
  ) => Promise<void>;
  removeOptimisticMessage: (id: string) => void;
};

export function ThreadView(props: ThreadViewProps) {
  const [pendingPlanEntry, setPendingPlanEntry] =
    useState<AppServerThreadPlanEntry>();
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();

  useEffect(() => {
    setPendingPlanEntry(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
    setExpandedImage(undefined);
  }, [
    props.selectedLaunchpad?.directoryKey,
    props.selectedThread?.id,
    props.selectedThread?.source,
  ]);

  const selectedThread = props.selectedThread;
  const selectedLaunchpad = props.selectedLaunchpad;

  useEffect(() => {
    if (!pendingPlanEntry) {
      return;
    }

    const persistedPlan = props.transcriptEntries.find(
      (entry): entry is AppServerThreadPlanEntry =>
        entry.type === "plan" && arePlanEntriesEquivalent(entry, pendingPlanEntry)
    );
    if (persistedPlan) {
      setPendingPlanEntry(undefined);
    }
  }, [pendingPlanEntry, props.transcriptEntries]);

  useEffect(() => {
    if (!props.desktopApi?.onAgentEvent || !selectedThread) {
      return;
    }

    return props.desktopApi.onAgentEvent((event) => {
      if (
        event.notification.method !== "turn/plan/updated" ||
        event.backend !== selectedThread.source ||
        event.notification.params.threadId !== selectedThread.id
      ) {
        return;
      }

      const planRecord =
        typeof event.notification.params.plan === "object" &&
        event.notification.params.plan !== null
          ? (event.notification.params.plan as {
              explanation?: unknown;
              steps?: unknown;
            })
          : undefined;

      if (!Array.isArray(planRecord?.steps)) {
        return;
      }

      const explanation =
        typeof planRecord.explanation === "string" && planRecord.explanation.trim()
          ? planRecord.explanation.trim()
          : undefined;

      setPendingPlanEntry({
        type: "plan",
        id: `live-plan-${
          typeof event.notification.params.runId === "string"
            ? event.notification.params.runId
            : selectedThread.id
        }`,
        createdAt: Date.now(),
        ...(explanation ? { explanation } : {}),
        steps: planRecord.steps,
      });
    });
  }, [props.desktopApi, selectedThread]);

  async function respondToPendingRequest(
    decision: "approve" | "decline" | "cancel"
  ): Promise<void> {
    if (!props.desktopApi?.submitServerRequest || !selectedThread || !props.pendingRequest) {
      setPendingRequestError("Desktop bridge is missing submitServerRequest().");
      return;
    }

    setPendingRequestBusy(true);
    setPendingRequestError(undefined);

    try {
      await props.desktopApi.submitServerRequest({
        backend: selectedThread.source,
        threadId: selectedThread.id,
        runId:
          typeof props.pendingRequest.params.runId === "string"
            ? props.pendingRequest.params.runId
            : undefined,
        requestId: props.pendingRequest.params.requestId,
        response: buildPendingRequestResponse(props.pendingRequest, decision),
      });
      props.clearPendingRequest(
        props.pendingRequest.params.requestId,
        decision === "approve" ? "Thinking" : undefined
      );
    } catch (error) {
      setPendingRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRequestBusy(false);
    }
  }

  if (!selectedThread && !selectedLaunchpad) {
    return (
      <section className="thread-empty-state">
        <p className="eyebrow">Thread detail</p>
        <h2>Select a thread</h2>
        <p>
          Inbox stays above every other lens. Pick a thread to read the full
          transcript, or open a project launchpad from Directories.
        </p>
      </section>
    );
  }

  if (selectedLaunchpad && props.selectedDirectory) {
    const launchpadBackend = props.backends.find(
      (backend) => backend.kind === selectedLaunchpad.backend
    );
    const syncLabel = formatDirectorySync(props.selectedDirectory);

    return (
      <section className="thread-view">
        <header className="thread-header">
          <div>
            <div className="thread-header__eyebrow-row">
              <p className="eyebrow">New thread</p>
              <span className="thread-row__chip thread-row__chip--backend">
                {formatBackendLabel(selectedLaunchpad.backend)}
              </span>
              <span className="thread-row__chip thread-row__chip--mode">
                {formatExecutionModeLabel(selectedLaunchpad.executionMode)}
              </span>
            </div>
            <h2 className="thread-header__title">{selectedLaunchpad.directoryLabel}</h2>
            <p className="thread-header__summary">
              Start a thread in this directory. Unsent prompt and setup changes stay attached to this launchpad until the first send.
            </p>
          </div>

          <div className="thread-header__stats">
            <div>
              <span className="thread-header__stat-label">Workspace</span>
              <strong>
                {selectedLaunchpad.workMode === "worktree" ? "New worktree" : "Local checkout"}
              </strong>
            </div>
            <div>
              <span className="thread-header__stat-label">Branch</span>
              <strong>
                {selectedLaunchpad.workMode === "worktree"
                  ? selectedLaunchpad.branchName ??
                    props.selectedDirectory.gitStatus?.currentBranch ??
                    "Pick one"
                  : props.selectedDirectory.gitStatus?.currentBranch ?? "Not attached"}
              </strong>
            </div>
          </div>
        </header>

        <div className="launchpad-panel">
          <div className="launchpad-panel__header">
            <div>
              <h3>Directory</h3>
              <p>
                {props.selectedDirectory.threadKeys.length} thread
                {props.selectedDirectory.threadKeys.length === 1 ? "" : "s"}
                {syncLabel ? ` • ${syncLabel}` : ""}
              </p>
            </div>
          </div>

          <dl className="launchpad-grid">
            <div>
              <dt>Path</dt>
              <dd>{props.selectedDirectory.path ?? "Not recorded"}</dd>
            </div>
            <div>
              <dt>Current branch</dt>
              <dd>{props.selectedDirectory.gitStatus?.currentBranch ?? "Not a Git repo"}</dd>
            </div>
            <div>
              <dt>Upstream</dt>
              <dd>{props.selectedDirectory.gitStatus?.upstreamBranch ?? "Not tracking"}</dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{syncLabel ?? "Directory context only"}</dd>
            </div>
          </dl>
        </div>

        <Composer
          backends={props.backends}
          desktopApi={props.desktopApi}
          directory={props.selectedDirectory}
          disabled={!launchpadBackend?.available}
          launchpad={selectedLaunchpad}
          launchpadError={props.launchpadError}
          onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
          onMaterializeLaunchpad={props.onMaterializeLaunchpad}
          onUpdateLaunchpad={props.onUpdateLaunchpad}
          skillError={props.skillError}
          skillLoading={props.skillLoading}
          skills={props.skills}
        />
      </section>
    );
  }

  return (
    <section className="thread-view">
      <ThreadHeader
        fetchedAt={props.fetchedAt}
        messageCount={props.messageCount}
        thread={selectedThread!}
      />

      <div className="thread-view__layout">
        <section className="transcript-panel" aria-label="Transcript">
          <div className="transcript-panel__header">
            <div>
              <h3>Transcript</h3>
              <p>
                {props.messageCount} message{props.messageCount === 1 ? "" : "s"}
              </p>
            </div>
          </div>

          <TranscriptList
            entries={props.transcriptEntries}
            error={props.transcriptError}
            loading={props.loading}
            loadingMore={props.loadingMore}
            pagination={props.transcriptPagination}
            pendingAssistantMessage={props.pendingAssistantMessage}
            pendingPlanEntry={pendingPlanEntry}
            pendingRequest={props.pendingRequest}
            pendingRequestBusy={pendingRequestBusy}
            pendingStatusText={props.pendingStatusText}
            skills={props.skills}
            threadId={selectedThread!.id}
            onLoadOlder={props.onLoadOlder}
            onOpenImage={setExpandedImage}
            onRespondToPendingRequest={respondToPendingRequest}
          />
          {pendingRequestError ? (
            <p className="transcript-error">{pendingRequestError}</p>
          ) : null}
        </section>

        <ThreadContextPanel
          backendError={props.backendError}
          backends={props.backends}
          platform={props.platform}
          thread={selectedThread!}
        />
      </div>

      {expandedImage ? (
        <TranscriptImageLightbox
          image={expandedImage}
          onClose={() => {
            setExpandedImage(undefined);
          }}
        />
      ) : null}

      <Composer
        activeRunId={props.activeRunId}
        addOptimisticUserMessage={props.addOptimisticUserMessage}
        backends={props.backends}
        desktopApi={props.desktopApi}
        disabled={props.composerDisabled}
        onActiveRunIdChange={props.onActiveRunIdChange}
        onEnsureSkillsLoaded={props.onEnsureSkillsLoaded}
        onPendingStatusChange={props.onPendingStatusChange}
        onSetExecutionMode={props.onSetExecutionMode}
        pendingRequestActive={Boolean(props.pendingRequest)}
        removeOptimisticMessage={props.removeOptimisticMessage}
        setExecutionModeError={props.setExecutionModeError}
        skillError={props.skillError}
        skillLoading={props.skillLoading}
        skills={props.skills}
        thread={selectedThread!}
        updatingExecutionMode={props.updatingExecutionMode}
      />
    </section>
  );
}

function buildPendingRequestResponse(
  request: AppServerPendingRequestNotification,
  decision: "approve" | "decline" | "cancel"
): { decision: string } {
  const availableDecision = selectAvailableDecision(request.params, decision);
  if (availableDecision) {
    return { decision: availableDecision };
  }

  if (request.method.includes("commandExecution/requestApproval")) {
    return {
      decision:
        decision === "approve"
          ? "accept"
          : decision === "decline"
            ? "decline"
            : "cancel",
    };
  }

  if (request.method.includes("fileChange/requestApproval")) {
    return {
      decision:
        decision === "approve"
          ? "accept"
          : decision === "decline"
            ? "decline"
            : "cancel",
    };
  }

  return { decision };
}

function selectAvailableDecision(
  params: AppServerPendingRequestNotification["params"],
  decision: "approve" | "decline" | "cancel"
): string | undefined {
  const rawDecisions =
    readDecisionStrings(params.availableDecisions) ?? readDecisionStrings(params.decisions);
  if (!rawDecisions?.length) {
    return undefined;
  }

  const acceptedAliases =
    decision === "approve"
      ? ["accept", "approve", "allow"]
      : decision === "decline"
        ? ["decline", "deny", "reject"]
        : ["cancel", "abort", "stop"];

  return rawDecisions.find((value) =>
    acceptedAliases.some((alias) => value.toLowerCase().includes(alias))
  );
}

function readDecisionStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry.trim();
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return undefined;
      }
      const record = entry as Record<string, unknown>;
      for (const key of ["decision", "value", "name", "id"]) {
        const raw = record[key];
        if (typeof raw === "string" && raw.trim()) {
          return raw.trim();
        }
      }
      return undefined;
    })
    .filter((entry): entry is string => Boolean(entry));
}

function formatDirectorySync(directory: NavigationDirectorySummary): string | undefined {
  const status = directory.gitStatus;
  if (!status) {
    return undefined;
  }

  if (status.syncState === "in-sync") {
    return "Up to date";
  }
  if (status.syncState === "ahead") {
    return `${status.ahead ?? 0} ahead`;
  }
  if (status.syncState === "behind") {
    return `${status.behind ?? 0} behind`;
  }
  if (status.syncState === "diverged") {
    return `${status.ahead ?? 0} ahead · ${status.behind ?? 0} behind`;
  }
  if (status.syncState === "untracked") {
    return "No upstream";
  }
  if (status.syncState === "status-unavailable") {
    return "Status unavailable";
  }

  return undefined;
}
