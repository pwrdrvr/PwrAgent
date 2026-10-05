import { type MouseEvent as ReactMouseEvent, type ReactNode, useId, useState } from "react";
import type { ReadQueuedTurnResponse } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { useViewportTooltip } from "../../lib/useViewportTooltip";
import { TurnInputContent } from "../thread-detail/TurnInputContent";

/**
 * The body of a one-line queued message row.
 *
 * The chevron is the disclosure: its hit area stretches over the whole line,
 * so a click anywhere on the summary opens the full message, as an env-action
 * row's summary does. The row's actions sit over the right end of the line
 * and show on hover or focus; `children` are the summary (label, title, image
 * chip) and `detail` is anything that needs its own line, such as an error.
 */
export function QueuedMessageInspector(props: {
  load: () => Promise<ReadQueuedTurnResponse>;
  desktopApi?: DesktopApi;
  actions?: ReactNode;
  detail?: ReactNode;
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
    <>
      <div className="composer__queued-line">
        <button
          className="composer__queued-disclosure"
          type="button"
          aria-label={expanded ? "Hide message" : "View full message"}
          aria-expanded={expanded}
          aria-controls={regionId}
          data-open={expanded ? "true" : undefined}
          onClick={() => expanded ? setExpanded(false) : void open()}
        >
          <span className="composer__queued-chevron" aria-hidden="true" />
        </button>
        {props.children}
      </div>
      {props.actions ? (
        <div className="composer__queued-actions">{props.actions}</div>
      ) : null}
      {props.detail}
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
    </>
  );
}

/**
 * An icon action on a queued row. The tooltip is portalled because the band
 * above the composer scrolls, and a CSS tooltip would be clipped by it.
 */
export function QueuedRowIconButton(props: {
  label: string;
  children: ReactNode;
  disabled?: boolean;
  tone?: "danger";
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}): ReactNode {
  const tooltip = useViewportTooltip({ className: "viewport-tooltip" });
  const show = (target: HTMLButtonElement): void => {
    if (!props.disabled) {
      tooltip.show(target, props.label);
    }
  };
  return (
    <>
      <button
        aria-label={props.label}
        className={[
          "composer__queued-icon-action",
          props.tone === "danger" ? "composer__queued-icon-action--danger" : "",
        ].filter(Boolean).join(" ")}
        disabled={props.disabled}
        type="button"
        onBlur={tooltip.hide}
        onClick={(event) => {
          tooltip.hide();
          props.onClick(event);
        }}
        onFocus={(event) => show(event.currentTarget)}
        onMouseEnter={(event) => show(event.currentTarget)}
        onMouseLeave={tooltip.hide}
      >
        {props.children}
      </button>
      {tooltip.tooltipNode}
    </>
  );
}
