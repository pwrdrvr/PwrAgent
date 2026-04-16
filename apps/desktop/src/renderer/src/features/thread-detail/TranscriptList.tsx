import type {
  AppServerThreadMessage,
  AppServerThreadReplayPagination
} from "@pwragnt/shared";
import { TranscriptMessage } from "./TranscriptMessage";

type TranscriptListProps = {
  error?: string;
  loading: boolean;
  loadingMore: boolean;
  messages: AppServerThreadMessage[];
  pagination?: AppServerThreadReplayPagination;
  onLoadOlder: () => Promise<void>;
};

export function TranscriptList(props: TranscriptListProps) {
  const canLoadOlder = Boolean(
    props.pagination?.supportsPagination && props.pagination.hasPreviousPage
  );

  if (props.loading && props.messages.length === 0) {
    return <p className="transcript-empty">Loading transcript…</p>;
  }

  if (props.error && props.messages.length === 0) {
    return <p className="transcript-error">{props.error}</p>;
  }

  if (props.messages.length === 0) {
    return <p className="transcript-empty">No thread history yet.</p>;
  }

  return (
    <div className="transcript-list">
      {canLoadOlder ? (
        <button
          className="button button--ghost transcript-list__load-older"
          type="button"
          onClick={() => {
            void props.onLoadOlder();
          }}
        >
          {props.loadingMore ? "Loading older messages" : "Load older messages"}
        </button>
      ) : null}

      {props.error ? <p className="transcript-error">{props.error}</p> : null}

      <div className="transcript-list__items" role="list">
        {props.messages.map((message) => (
          <TranscriptMessage key={message.id} message={message} />
        ))}
      </div>
    </div>
  );
}
