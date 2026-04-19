import { useEffect, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
  AppServerThreadPlanEntry,
  AppServerSkillSummary,
  AppServerThreadReplayPagination,
  BackendSummary,
  NavigationDirectorySummary,
  NavigationLaunchpadDraft,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { Composer } from "../composer/Composer";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatBackendLabel } from "../../lib/backend-label";
import { formatExecutionModeLabel } from "../../lib/execution-mode";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadHeader } from "./ThreadHeader";
import { TranscriptImageLightbox } from "./TranscriptImageLightbox";
import { TranscriptList } from "./TranscriptList";

function formatRendererLogPayload(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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
  addOptimisticUserMessage: (text: string) => string;
  backendError?: string;
  backends: BackendSummary[];
  composerDisabled: boolean;
  desktopApi?: DesktopApi;
  fetchedAt?: number;
  launchpadError?: string;
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  platform?: string;
  selectedDirectory?: NavigationDirectorySummary;
  selectedLaunchpad?: NavigationLaunchpadDraft;
  selectedThread?: NavigationThreadSummary;
  setExecutionModeError?: string;
  skillError?: string;
  skillLoading?: boolean;
  skills: AppServerSkillSummary[];
  transcriptError?: string;
  transcriptEntries: AppServerThreadEntry[];
  transcriptPagination?: AppServerThreadReplayPagination;
  updatingExecutionMode?: ThreadExecutionMode;
  onLoadOlder: () => Promise<void>;
  onMaterializeLaunchpad?: (
    directoryKey: string,
    input?: Array<{ type: "text"; text: string }>
  ) => Promise<void>;
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
  onRefresh: () => Promise<void>;
};

export function ThreadView(props: ThreadViewProps) {
  const [pendingStatusText, setPendingStatusText] = useState<string>();
  const [pendingAssistantMessage, setPendingAssistantMessage] =
    useState<AppServerThreadMessageEntry>();
  const [pendingPlanEntry, setPendingPlanEntry] =
    useState<AppServerThreadPlanEntry>();
  const [pendingRequest, setPendingRequest] =
    useState<AppServerPendingRequestNotification>();
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();

  useEffect(() => {
    setPendingAssistantMessage(undefined);
    setPendingPlanEntry(undefined);
    setPendingRequest(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
    setExpandedImage(undefined);
  }, [props.selectedThread?.id, props.selectedThread?.source, props.selectedLaunchpad?.directoryKey]);

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
      const method = event.notification.method;
      const statusRecord =
        method === "thread/status/changed" &&
        typeof event.notification.params.status === "object" &&
        event.notification.params.status !== null
          ? (event.notification.params.status as { type?: unknown })
          : undefined;
      const planRecord =
        method === "turn/plan/updated" &&
        typeof event.notification.params.plan === "object" &&
        event.notification.params.plan !== null
          ? (event.notification.params.plan as {
              explanation?: unknown;
              steps?: unknown;
            })
          : undefined;
      if (
        event.backend !== selectedThread.source ||
        event.notification.params.threadId !== selectedThread.id
      ) {
        return;
      }

      if (
        method.endsWith("/requestApproval") &&
        "requestId" in event.notification.params
      ) {
        setPendingRequest(
          event.notification as AppServerPendingRequestNotification
        );
        setPendingRequestBusy(false);
        setPendingRequestError(undefined);
        setPendingStatusText("Waiting for approval");
        return;
      }

      if (
        method === "turn/plan/updated" &&
        Array.isArray(planRecord?.steps)
      ) {
        const explanation =
          typeof planRecord.explanation === "string" &&
          planRecord.explanation.trim()
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
          steps: planRecord.steps
        });
        return;
      }

      if (
        method === "item/agentMessage/delta" &&
        "itemId" in event.notification.params &&
        typeof event.notification.params.itemId === "string" &&
        typeof event.notification.params.delta === "string"
      ) {
        setPendingRequest(undefined);
        setPendingRequestBusy(false);
        setPendingRequestError(undefined);
        setPendingStatusText("Thinking");
        const { itemId, delta } = event.notification.params;
        setPendingAssistantMessage((current) => ({
          type: "message",
          id: itemId,
          role: "assistant",
          text: current?.id === itemId ? `${current.text}${delta}` : delta,
        }));
        return;
      }

      if (
        method === "serverRequest/resolved" &&
        "requestId" in event.notification.params
      ) {
        const requestId = event.notification.params.requestId;
        setPendingRequest((current) =>
          current?.params.requestId === requestId ? undefined : current
        );
        setPendingRequestBusy(false);
        setPendingRequestError(undefined);
        setPendingStatusText("Thinking");
        return;
      }

      if (
        method === "turn/completed" ||
        method === "turn/failed" ||
        method === "turn/cancelled" ||
        (method === "thread/status/changed" && statusRecord?.type === "idle")
      ) {
        setPendingAssistantMessage(undefined);
        setPendingRequest(undefined);
        setPendingRequestBusy(false);
        setPendingRequestError(undefined);
        if (method !== "turn/completed") {
          setPendingStatusText(undefined);
        }
      }

      if (method.includes("/request")) {
        console.error(
          `[pwragnt:thread-view] unhandled thread request event ${formatRendererLogPayload({
            backend: event.backend,
            threadId: selectedThread.id,
            method,
            params: event.notification.params,
          })}`
        );
      }
    });
  }, [props.desktopApi, selectedThread]);

  async function respondToPendingRequest(
    decision: "approve" | "decline" | "cancel"
  ): Promise<void> {
    if (!props.desktopApi?.submitServerRequest || !selectedThread || !pendingRequest) {
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
          typeof pendingRequest.params.runId === "string"
            ? pendingRequest.params.runId
            : undefined,
        requestId: pendingRequest.params.requestId,
        response: buildPendingRequestResponse(pendingRequest, decision),
      });
      setPendingRequest(undefined);
      setPendingStatusText(decision === "approve" ? "Thinking" : undefined);
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
                  ? selectedLaunchpad.branchName ?? props.selectedDirectory.gitStatus?.currentBranch ?? "Pick one"
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
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                void props.onRefresh();
              }}
            >
              Refresh
            </button>
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
          onMaterializeLaunchpad={props.onMaterializeLaunchpad}
          onRefresh={props.onRefresh}
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
            <button
              className="button button--ghost"
              type="button"
              onClick={() => {
                void props.onRefresh();
              }}
            >
              Refresh
            </button>
          </div>

          <TranscriptList
            error={props.transcriptError}
            entries={props.transcriptEntries}
            loading={props.loading}
            loadingMore={props.loadingMore}
            pendingAssistantMessage={pendingAssistantMessage}
            pendingPlanEntry={pendingPlanEntry}
            pendingRequest={pendingRequest}
            pendingRequestBusy={pendingRequestBusy}
            pendingStatusText={pendingStatusText}
            pagination={props.transcriptPagination}
            threadId={selectedThread!.id}
            skills={props.skills}
            onOpenImage={setExpandedImage}
            onRespondToPendingRequest={respondToPendingRequest}
            onLoadOlder={props.onLoadOlder}
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
        addOptimisticUserMessage={props.addOptimisticUserMessage}
        backends={props.backends}
        desktopApi={props.desktopApi}
        disabled={props.composerDisabled}
        pendingRequestActive={Boolean(pendingRequest)}
        onPendingStatusChange={setPendingStatusText}
        onRefresh={props.onRefresh}
        onSetExecutionMode={props.onSetExecutionMode}
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
  decision: "approve" | "decline" | "cancel",
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
  decision: "approve" | "decline" | "cancel",
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
    acceptedAliases.some((alias) => value.toLowerCase().includes(alias)),
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
