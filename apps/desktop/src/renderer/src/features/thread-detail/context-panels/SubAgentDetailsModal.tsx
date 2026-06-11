import { useEffect } from "react";
import { createPortal } from "react-dom";
import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { formatTimestamp } from "./context-rail-shared";
import {
  formatTokenCount,
  formatUsd,
  subAgentStatusLabel,
  subAgentTone,
} from "./subagent-format";

type SubAgentDetailsModalProps = {
  subAgent: ThreadSubAgentSummary;
  onClose: () => void;
};

/**
 * Centered, in-window detail view for a single sub-agent — opened from the
 * card's Details button. Mirrors {@link TranscriptImageLightbox}: a fixed
 * scrim that closes on backdrop click or Escape, portaled to the body so it
 * escapes the context rail's clipping + transforms. Surfaces the request,
 * final response, run timing, model, and token/pricing usage.
 */
export function SubAgentDetailsModal(props: SubAgentDetailsModalProps) {
  const { subAgent } = props;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [props.onClose]);

  const tone = subAgentTone(subAgent.status);
  const usage = subAgent.monitorUsage;
  const model = subAgent.preferredModel ?? usage?.model ?? usage?.cost?.model;

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="subagent-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Sub-agent details: ${subAgent.task}`}
      onClick={props.onClose}
    >
      <div
        className="subagent-modal__content"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="subagent-modal__head">
          <span className="subagent-card__status-line">
            <span
              aria-hidden="true"
              className={`subagent-card__dot subagent-card__dot--${tone}`}
            />
            <span className={`subagent-card__status subagent-card__status--${tone}`}>
              {subAgentStatusLabel(subAgent.status)}
            </span>
          </span>
          <button
            type="button"
            className="button button--ghost subagent-modal__close"
            onClick={props.onClose}
          >
            Close
          </button>
        </div>

        <h2 className="subagent-modal__title">{subAgent.task}</h2>

        <dl className="subagent-modal__facts">
          {model ? (
            <div>
              <dt>Model</dt>
              <dd className="subagent-modal__mono">{model}</dd>
            </div>
          ) : null}
          {subAgent.preferredReasoningEffort ? (
            <div>
              <dt>Reasoning</dt>
              <dd>{subAgent.preferredReasoningEffort}</dd>
            </div>
          ) : null}
          <div>
            <dt>Started</dt>
            <dd>{formatTimestamp(subAgent.createdAt)}</dd>
          </div>
          {subAgent.completedAt ? (
            <div>
              <dt>Ended</dt>
              <dd>{formatTimestamp(subAgent.completedAt)}</dd>
            </div>
          ) : null}
        </dl>

        <section className="subagent-modal__section">
          <h3>Final response</h3>
          <p className="subagent-modal__body">
            {subAgent.lastMessage ?? "No response yet."}
          </p>
        </section>

        {usage ? (
          <section className="subagent-modal__section">
            <h3>Tokens &amp; pricing</h3>
            <dl className="subagent-modal__facts">
              {usage.tokenUsage.inputTokens !== undefined ? (
                <div>
                  <dt>Input</dt>
                  <dd>{formatTokenCount(usage.tokenUsage.inputTokens)}</dd>
                </div>
              ) : null}
              {usage.tokenUsage.outputTokens !== undefined ? (
                <div>
                  <dt>Output</dt>
                  <dd>{formatTokenCount(usage.tokenUsage.outputTokens)}</dd>
                </div>
              ) : null}
              {usage.tokenUsage.reasoningOutputTokens !== undefined ? (
                <div>
                  <dt>Reasoning</dt>
                  <dd>{formatTokenCount(usage.tokenUsage.reasoningOutputTokens)}</dd>
                </div>
              ) : null}
              {usage.tokenUsage.totalTokens !== undefined ? (
                <div>
                  <dt>Total</dt>
                  <dd>{formatTokenCount(usage.tokenUsage.totalTokens)}</dd>
                </div>
              ) : null}
              {usage.cost ? (
                <div>
                  <dt>Cost</dt>
                  <dd>{formatUsd(usage.cost.totalUsd)}</dd>
                </div>
              ) : null}
            </dl>
            {usage.summary ? (
              <p className="subagent-modal__usage-summary">{usage.summary}</p>
            ) : null}
          </section>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
