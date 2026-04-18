import { useEffect, useState } from "react";
import type {
  AppServerPendingRequestNotification,
  AppServerThreadEntry,
  AppServerThreadImagePart,
  AppServerThreadMessageEntry,
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
import { TranscriptImageLightbox } from "./TranscriptImageLightbox";
import { TranscriptList } from "./TranscriptList";

function formatRendererLogPayload(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

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
  const [pendingAssistantMessage, setPendingAssistantMessage] =
    useState<AppServerThreadMessageEntry>();
  const [pendingRequest, setPendingRequest] =
    useState<AppServerPendingRequestNotification>();
  const [pendingRequestBusy, setPendingRequestBusy] = useState(false);
  const [pendingRequestError, setPendingRequestError] = useState<string>();
  const [expandedImage, setExpandedImage] = useState<AppServerThreadImagePart>();

  useEffect(() => {
    setPendingAssistantMessage(undefined);
    setPendingRequest(undefined);
    setPendingRequestBusy(false);
    setPendingRequestError(undefined);
    setExpandedImage(undefined);
  }, [props.selectedThread?.id, props.selectedThread?.source]);

  const selectedThread = props.selectedThread;

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
        method === "item/agentMessage/delta" &&
        "itemId" in event.notification.params &&
        typeof event.notification.params.itemId === "string" &&
        typeof event.notification.params.delta === "string"
      ) {
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
            pendingAssistantMessage={pendingAssistantMessage}
            pendingRequest={pendingRequest}
            pendingRequestBusy={pendingRequestBusy}
            pendingStatusText={pendingStatusText}
            pagination={props.transcriptPagination}
            threadId={selectedThread.id}
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
          setExecutionModeError={props.setExecutionModeError}
          thread={selectedThread}
          updatingExecutionMode={props.updatingExecutionMode}
          onSetExecutionMode={props.onSetExecutionMode}
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
