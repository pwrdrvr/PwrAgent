import type {
  AppServerThreadEntry,
  AppServerThreadReplayPagination,
  BackendSummary,
  NavigationThreadSummary
} from "@pwragnt/shared";
import { Composer } from "../composer/Composer";
import { ThreadContextPanel } from "./ThreadContextPanel";
import { ThreadHeader } from "./ThreadHeader";
import { TranscriptList } from "./TranscriptList";

type ThreadViewProps = {
  backendError?: string;
  backends: BackendSummary[];
  fetchedAt?: number;
  loading: boolean;
  loadingMore: boolean;
  messageCount: number;
  platform?: string;
  selectedThread?: NavigationThreadSummary;
  transcriptError?: string;
  transcriptEntries: AppServerThreadEntry[];
  transcriptPagination?: AppServerThreadReplayPagination;
  onLoadOlder: () => Promise<void>;
  onRefresh: () => Promise<void>;
};

export function ThreadView(props: ThreadViewProps) {
  if (!props.selectedThread) {
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
        thread={props.selectedThread}
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
            pagination={props.transcriptPagination}
            threadId={props.selectedThread.id}
            onLoadOlder={props.onLoadOlder}
          />
        </section>

        <ThreadContextPanel
          backendError={props.backendError}
          backends={props.backends}
          platform={props.platform}
          thread={props.selectedThread}
        />
      </div>

      <Composer disabled />
    </section>
  );
}
