import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import type { ThreadSubAgentSummary } from "@pwragent/shared";
import { formatTimestamp } from "./context-rail-shared";
import {
  formatTokenCount,
  formatUsd,
  subAgentStatusLabel,
  subAgentTone,
} from "./subagent-format";
import { RailStatusChip } from "./RailStatusChip";

type SubAgentDetailsModalProps = {
  subAgent: ThreadSubAgentSummary;
  onClose: () => void;
};

/**
 * Centered, in-window detail view for a single sub-agent — opened from the
 * card's Details button. Mirrors {@link ImageLightbox}: a fixed
 * scrim that closes on backdrop click or Escape, portaled to the body so it
 * escapes the context rail's clipping + transforms. Surfaces the request,
 * final response, run timing, model, and token/pricing usage.
 */
export function SubAgentDetailsModal(props: SubAgentDetailsModalProps) {
  const { subAgent } = props;
  const contentRef = useRef<HTMLDivElement>(null);

  // Dialog focus management: move focus into the dialog on open, keep Tab
  // cycling within it (so focus can't fall behind the scrim), restore focus
  // to the opener on close, and close on Escape.
  useEffect(() => {
    const restoreFocus = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      Array.from(
        contentRef.current?.querySelectorAll<HTMLElement>(
          'button, a[href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((el) => !el.hasAttribute("disabled"));

    focusables()[0]?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        return;
      }
      if (event.key !== "Tab") {
        return;
      }
      const items = focusables();
      if (items.length === 0) {
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!contentRef.current?.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      restoreFocus?.focus?.();
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
        ref={contentRef}
        className="subagent-modal__content"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="subagent-modal__head">
          <RailStatusChip tone={tone} alert={tone === "error"}>
            {subAgentStatusLabel(subAgent.status)}
          </RailStatusChip>
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
          <h3>Latest message</h3>
          <p className="subagent-modal__body">
            {subAgent.lastMessage ?? "No messages yet."}
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
