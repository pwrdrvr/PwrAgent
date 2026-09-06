import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type {
  AppServerBackendKind,
  FederationTarget,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { CloseIcon } from "../../../icons";
import { formatBackendLabel } from "../../../lib/backend-label";
import { copyText } from "../../../lib/copy-text";
import { useDesktopApi } from "../../../lib/desktop-api";
import { formatTimestamp } from "./context-rail-shared";
import {
  formatSubAgentUsageEstimates,
  formatSubAgentUsageSummary,
  formatTokenCount,
  isTerminalSubAgent,
  type PricingDisplayOptions,
  subAgentCompletedAt,
  subAgentStatusLabel,
  subAgentTone,
} from "./subagent-format";
import { LiveRailCardTiming } from "./RailCardTiming";
import { RailStatusChip } from "./RailStatusChip";
import { subAgentOriginLabel } from "./subagent-kind";

type SubAgentDetailsModalProps = {
  defaultBackend: AppServerBackendKind;
  federationTarget?: FederationTarget;
  parentThreadId: string;
  pricingDisplayOptions?: PricingDisplayOptions;
  subAgent: ThreadSubAgentSummary;
  onClose: () => void;
};

/**
 * Centered, in-window detail view for a single sub-agent — opened from the
 * card's Details button. Mirrors {@link ImageLightbox}: a fixed scrim that
 * closes on backdrop click or Escape, portaled to the body so it escapes the
 * context rail's clipping + transforms.
 *
 * Layout deliberately reads as the rail card, expanded: a pinned header
 * carrying identity (status, name, provider/model, timing) over a scrolling
 * body. The task prompt is a clamped block inside that body rather than the
 * dialog's headline — a monitor prompt runs to hundreds of words and pushed
 * every fact worth reading below the fold.
 */
export function SubAgentDetailsModal(props: SubAgentDetailsModalProps) {
  const { onClose, subAgent } = props;
  const contentRef = useRef<HTMLDivElement>(null);
  const desktopApi = useDesktopApi();
  const openSubAgentTranscriptWindow = desktopApi?.openSubAgentTranscriptWindow;

  // The dialog stays mounted while the sub-agent streams updates, and the
  // opener hands us a fresh `onClose` on every one of those renders. Reading
  // it through a ref keeps the focus effect below a true mount/unmount effect:
  // re-running it would re-focus the header on each poll, and the browser
  // would scroll the focused element into view — silently yanking a
  // half-read prompt back to the top.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

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

    // Close explicitly, not `focusables()[0]`: the header's timing line is
    // tabbable once the run settles (its duration carries the exact end
    // timestamp), and it precedes the actions in DOM order. Taking the first
    // focusable would open a finished sub-agent with focus parked on a span
    // and its tooltip already showing.
    const closeButton = contentRef.current?.querySelector<HTMLElement>(
      ".subagent-modal__close",
    );
    (closeButton ?? focusables()[0])?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
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
  }, []);

  const tone = subAgentTone(subAgent.status);
  const usage = subAgent.monitorUsage;
  const model = subAgent.preferredModel ?? usage?.model ?? usage?.cost?.model;
  const fastMode = subAgent.preferredFastMode ?? usage?.fastMode;
  const running = !isTerminalSubAgent(subAgent);
  const transcriptThreadId =
    subAgent.monitorThreadId &&
    subAgent.monitorThreadId !== props.parentThreadId
      ? subAgent.monitorThreadId
      : undefined;
  const backendLabel = formatBackendLabel(subAgent.backend ?? props.defaultBackend);
  const usageEstimates = usage
    ? formatSubAgentUsageEstimates({
        displayOptions: props.pricingDisplayOptions,
        model,
        usage,
      })
    : undefined;
  const originLabel = subAgentOriginLabel(subAgent);
  const runtimeDetails = [
    model,
    subAgent.preferredReasoningEffort,
    fastMode ? "Fast" : undefined,
  ].filter((value): value is string => Boolean(value));
  // Identity first: a name if the spawner gave one, otherwise what kind of
  // sub-agent this is. Never the prompt.
  const headline = subAgent.agentName ?? originLabel ?? "Sub-agent";
  // The headline already says what spawned this when there is no agent name,
  // so the Source fact would only restate it.
  const showSourceFact = Boolean(subAgent.agentName && originLabel);

  if (typeof document === "undefined") {
    return null;
  }

  return createPortal(
    <div
      className="subagent-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Sub-agent details: ${headline}`}
      onClick={props.onClose}
    >
      <div
        ref={contentRef}
        className="subagent-modal__content"
        onClick={(event) => event.stopPropagation()}
      >
        {/* A plain div, not <header>: inside the dialog it would expose a
            stray banner landmark. */}
        <div className="subagent-modal__head">
          <div className="subagent-modal__identity">
            <p className="subagent-modal__status-line">
              <RailStatusChip tone={tone} alert={tone === "error"}>
                {subAgentStatusLabel(subAgent.status)}
              </RailStatusChip>
            </p>
            <h2 className="subagent-modal__title">{headline}</h2>
            <p className="rail-card__runtime">
              <span className="rail-card__provider-chip">{backendLabel}</span>
              {runtimeDetails.length > 0 ? (
                <span className="rail-card__model">
                  {runtimeDetails.join(" · ")}
                </span>
              ) : null}
            </p>
            <LiveRailCardTiming
              completedAt={subAgentCompletedAt(subAgent)}
              running={running}
              startedAt={subAgent.createdAt}
            />
          </div>
          <div className="subagent-modal__actions">
            {openSubAgentTranscriptWindow && transcriptThreadId ? (
              <button
                type="button"
                className="button button--ghost subagent-modal__open-transcript"
                onClick={() => {
                  void openSubAgentTranscriptWindow({
                    backend: subAgent.backend ?? props.defaultBackend,
                    ...(props.federationTarget
                      ? { federationTarget: props.federationTarget }
                      : {}),
                    threadId: transcriptThreadId,
                    title: subAgent.agentName ?? subAgent.task,
                  });
                  props.onClose();
                }}
              >
                Open transcript
              </button>
            ) : null}
            <button
              type="button"
              className="subagent-modal__close"
              aria-label="Close"
              title="Close"
              onClick={props.onClose}
            >
              <CloseIcon size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        <div className="subagent-modal__body">
          <ClampedTextSection copyable heading="Task" text={subAgent.task} />

          <ClampedTextSection
            heading="Latest message"
            placeholder="No messages yet."
            text={subAgent.lastMessage}
          />

          {/* Only facts the pinned header does not already carry. Provider,
              model, effort, fast mode, and the start time live up there; a dl
              repeating them one scroll down is noise, not detail. */}
          {showSourceFact || subAgent.completedAt !== undefined ? (
            <section className="subagent-modal__section">
              <div className="subagent-modal__section-head">
                <h3>Run</h3>
              </div>
              <dl className="subagent-modal__facts">
                {showSourceFact ? (
                  <div>
                    <dt>Source</dt>
                    <dd>{originLabel}</dd>
                  </div>
                ) : null}
                {subAgent.completedAt !== undefined ? (
                  <div>
                    <dt>Ended</dt>
                    <dd>{formatTimestamp(subAgent.completedAt)}</dd>
                  </div>
                ) : null}
              </dl>
            </section>
          ) : null}

          {usage ? (
            <section className="subagent-modal__section">
              <div className="subagent-modal__section-head">
                <h3>Tokens &amp; pricing</h3>
              </div>
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
                {usageEstimates ? (
                  <div>
                    <dt>Cost</dt>
                    <dd>{usageEstimates}</dd>
                  </div>
                ) : null}
              </dl>
              {usage.summary ? (
                <p className="subagent-modal__usage-summary">
                  {formatSubAgentUsageSummary({
                    displayOptions: props.pricingDisplayOptions,
                    model,
                    usage,
                  })}
                </p>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

type ClampedTextSectionProps = {
  copyable?: boolean;
  heading: string;
  placeholder?: string;
  text?: string;
};

/**
 * A long free-text block (task prompt, latest message) clamped to a few lines
 * with an in-place expander. The toggle only appears once the text actually
 * overflows, measured after layout rather than guessed from length — a
 * wrapped prompt's line count depends on the dialog width.
 */
function ClampedTextSection(props: ClampedTextSectionProps) {
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = props.text;

  useLayoutEffect(() => {
    const element = textRef.current;
    if (!element || expanded) {
      return;
    }
    const measure = () => {
      setOverflowing(element.scrollHeight > element.clientHeight + 1);
    };
    measure();
    // Whether the clamp bites depends on how the text wraps, which depends on
    // width — so a resized window can start truncating a block that measured
    // as fitting. Without re-measuring, the rest of the text is unreachable:
    // clipped, with no expander offered. ResizeObserver is absent under jsdom;
    // the initial measure is enough there.
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, text]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timerId = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timerId);
  }, [copied]);

  if (!text) {
    return (
      <section className="subagent-modal__section">
        <div className="subagent-modal__section-head">
          <h3>{props.heading}</h3>
        </div>
        <p className="subagent-modal__body-text subagent-modal__body-text--empty">
          {props.placeholder ?? "—"}
        </p>
      </section>
    );
  }

  return (
    <section className="subagent-modal__section">
      <div className="subagent-modal__section-head">
        <h3>{props.heading}</h3>
        <div className="subagent-modal__section-actions">
          {overflowing ? (
            <button
              type="button"
              className="subagent-modal__text-action"
              aria-expanded={expanded}
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          ) : null}
          {props.copyable ? (
            <button
              type="button"
              className="subagent-modal__text-action"
              onClick={() => {
                void copyText(text).then(() => setCopied(true));
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          ) : null}
        </div>
      </div>
      <p
        ref={textRef}
        className={`subagent-modal__body-text${
          expanded ? " subagent-modal__body-text--expanded" : ""
        }`}
      >
        {text}
      </p>
    </section>
  );
}
