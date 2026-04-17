import { useEffect, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadEntry,
  AppServerSkillSummary,
  AppServerThreadReplayPagination,
  BackendSummary,
  NavigationThreadSummary,
  ThreadExecutionMode,
} from "@pwragnt/shared";
import { Composer } from "../composer/Composer";
import type { DesktopApi } from "../../lib/desktop-api";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadHeader } from "./ThreadHeader";
import { TranscriptList } from "./TranscriptList";

type ThreadViewProps = {
  addOptimisticUserMessage: (text: string) => string;
  backendError?: string;
  backends: BackendSummary[];
  composerDisabled: boolean;
  desktopApi?: DesktopApi;
  fetchedAt?: number;
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  platform?: string;
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
  onSetExecutionMode?: (executionMode: ThreadExecutionMode) => Promise<void>;
  removeOptimisticMessage: (id: string) => void;
  onRefresh: () => Promise<void>;
};

export function ThreadView(props: ThreadViewProps) {
  const [pendingStatusText, setPendingStatusText] = useState<string>();
  const [pendingRequest, setPendingRequest] =
    useState<AppServerPendingRequestNotification>();
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();

  useEffect(() => {
    setPendingRequest(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
  }, [props.selectedThread?.id, props.selectedThread?.source]);

  const selectedThread = props.selectedThread;

  useEffect(() => {
    if (!props.desktopApi?.onAgentEvent || !selectedThread) {
      return;
    }

    return props.desktopApi.onAgentEvent((event) => {
      if (
        event.backend !== selectedThread.source ||
        event.notification.params.threadId !== selectedThread.id
      ) {
        return;
      }

      if (
        event.notification.method === "turn/requestApproval" ||
        event.notification.method === "review/requestApproval"
      ) {
        setPendingRequest(event.notification);
        setPendingRequestBusy(false);
        setPendingRequestError(undefined);
        setPendingStatusText("Waiting for approval");
        return;
      }

      if (
        event.notification.method === "serverRequest/resolved" &&
        "requestId" in event.notification.params
      ) {
        const requestId = event.notification.params.requestId;
        setPendingRequest((current) =>
          current?.params.requestId === requestId ? undefined : current
        );
        setPendingRequestBusy(false);
        setPendingRequestError(undefined);
        setPendingStatusText("Thinking");
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
        response: { decision },
      });
      setPendingStatusText(decision === "approve" ? "Thinking" : undefined);
      if (decision !== "approve") {
        setPendingRequest(undefined);
      }
    } catch (error) {
      setPendingRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setPendingRequestBusy(false);
    }
  }

  if (!selectedThread) {
    return (
      <section className="thread-empty-state">
        <p className="eyebrow">Thread detail</p>
        <h2>Select a thread</h2>
        <p>
          Inbox stays above every other lens. Pick a thread to read the full
          transcript and inspect its linked directories.
        </p>
      </section>
    );
  }

  return (
    <section className="thread-view">
      <ThreadHeader
        fetchedAt={props.fetchedAt}
        messageCount={props.messageCount}
        thread={selectedThread}
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
            pendingRequest={pendingRequest}
            pendingRequestBusy={pendingRequestBusy}
            pendingStatusText={pendingStatusText}
            pagination={props.transcriptPagination}
            threadId={selectedThread.id}
            skills={props.skills}
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
          setExecutionModeError={props.setExecutionModeError}
          thread={selectedThread}
          updatingExecutionMode={props.updatingExecutionMode}
          onSetExecutionMode={props.onSetExecutionMode}
        />
      </div>

      <Composer
        addOptimisticUserMessage={props.addOptimisticUserMessage}
        desktopApi={props.desktopApi}
        disabled={props.composerDisabled}
        pendingRequestActive={Boolean(pendingRequest)}
        onPendingStatusChange={setPendingStatusText}
        onRefresh={props.onRefresh}
        removeOptimisticMessage={props.removeOptimisticMessage}
        skillError={props.skillError}
        skillLoading={props.skillLoading}
        skills={props.skills}
        thread={selectedThread}
      />
    </section>
  );
}
