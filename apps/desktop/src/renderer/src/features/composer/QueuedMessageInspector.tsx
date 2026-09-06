import { type ReactNode, useId, useState } from "react";
import type { ReadQueuedTurnResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { TurnInputContent } from "../thread-detail/TurnInputContent";

export function QueuedMessageInspector(props: {
  load: () => Promise<ReadQueuedTurnResponse>;
  desktopApi?: DesktopApi;
  children?: ReactNode;
}) {
  const regionId = useId();
  const [content, setContent] = useState<ReadQueuedTurnResponse>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const open = async () => {
    setExpanded(true);
    setLoading(true);
    setError(undefined);
    setContent(undefined);
    try {
      setContent(await props.load());
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };
  return (
    <div className="queued-message-inspector-shell">
      <div className="queued-message-inspector-toolbar">
        <button
          className="composer__secondary-action"
          type="button"
          aria-expanded={expanded}
          aria-controls={regionId}
          onClick={() => expanded ? setExpanded(false) : void open()}
        >
          {expanded ? "Hide message" : "View full message"}
        </button>
        <div className="composer__queued-actions">{props.children}</div>
      </div>
      {expanded ? (
        <div
          id={regionId}
          className="queued-message-inspector"
          role="region"
          aria-label="Full queued message"
          tabIndex={0}
        >
          {loading ? <span role="status">Loading message…</span> : null}
          {error ? (
            <div role="alert">
              {error}
              <button className="composer__secondary-action" type="button" onClick={() => void open()}>
                Retry
              </button>
            </div>
          ) : null}
          {content ? (
            <TurnInputContent
              input={content.input}
              imageParts={content.imageParts}
              origin={content.messageOrigin}
              desktopApi={props.desktopApi}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
