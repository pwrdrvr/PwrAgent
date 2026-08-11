import { useState, type ReactNode } from "react";
import type { AutomationDetail, NavigationThreadSummary } from "@pwragent/shared";
import type { DesktopApi } from "../../lib/desktop-api";
import { formatRunningDurationMs } from "../../lib/format-duration";
import { useNowWhileActive } from "../thread-detail/context-panels/RailCardTiming";
import { useAutomations } from "./useAutomations";

function isRunningAutomation(automation: AutomationDetail): boolean {
  return (
    automation.lastRunStatus === "running"
    || automation.lastRunStatus === "queued"
    || automation.lastRunStatus === "pending"
  );
}

/**
 * Automations mid-flight or newly failed, as a compact strip above the
 * composer.
 *
 * Every completed run used to post its own card into the transcript, so an
 * Agent watching a busy channel accumulated a wall of "Continue monitoring."
 * entries between the messages an operator was actually reading. A completed
 * run is history: it belongs in the Automations rail and screen, which list
 * every run with its cost and transcript. What belongs in the operator's
 * eyeline is only what is happening now or what broke.
 *
 * Reads the same per-thread automation list the rail panel uses — no extra
 * IPC, and it refreshes on the run events that hook already subscribes to.
 */
export function ActiveAutomationRunsStrip(props: {
  desktopApi?: DesktopApi;
  thread?: NavigationThreadSummary;
}): ReactNode {
  const [dismissedFailures, setDismissedFailures] = useState<Set<string>>(
    () => new Set(),
  );
  const automations = useAutomations(
    props.thread ? props.desktopApi : undefined,
    props.thread
      ? { backend: props.thread.source, threadId: props.thread.id }
      : undefined,
  );

  const running = automations.automations.filter(isRunningAutomation);
  // Failures linger until dismissed, for the same reason the sub-agent strip
  // keeps them: the strip disappearing is how an operator misses one, and
  // neither the rail nor the Automations screen is in their eyeline while
  // they are typing. Cancelled runs leave immediately — someone asked for it.
  const failed = automations.automations.filter(
    (automation) =>
      automation.lastRunStatus === "failed"
      && !dismissedFailures.has(`${automation.id}:${automation.lastRunId ?? ""}`),
  );
  const visible = [...running, ...failed];

  const now = useNowWhileActive(running.length > 0);

  if (visible.length === 0) {
    return null;
  }

  const heading = running.length > 0 ? "Running automations" : "Failed automations";
  const headingCount = running.length > 0 ? running.length : failed.length;
  const failedNote =
    running.length > 0 && failed.length > 0 ? `${failed.length} failed` : undefined;

  const dismiss = (automation: AutomationDetail): void => {
    setDismissedFailures((current) =>
      new Set(current).add(`${automation.id}:${automation.lastRunId ?? ""}`),
    );
  };

  return (
    <section className="live-strip" aria-label={heading}>
      <div className="live-strip__header">
        <div className="live-strip__row live-strip__row--static">
          <span className="live-strip__label">{heading}</span>
          <span className="live-strip__count">{headingCount}</span>
          <span className="live-strip__row-spacer" />
          {failedNote ? (
            <span className="live-strip__note">{failedNote}</span>
          ) : null}
        </div>
      </div>
      <ul className="live-strip__list">
        {visible.map((automation) => {
          const failedRow = automation.lastRunStatus === "failed";
          const startedAt = automation.lastRunAt;
          return (
            <li
              className={`live-strip__item${
                failedRow ? " live-strip__item--failed" : ""
              }`}
              key={automation.id}
            >
              <span
                aria-hidden="true"
                className={
                  failedRow
                    ? "status-dot status-dot--error"
                    : "status-dot status-dot--active status-dot--blink"
                }
              />
              <span className="live-strip__item-text" title={automation.name}>
                {automation.name}
              </span>
              {/* Never color alone — the row says its state in words. */}
              <span className="live-strip__item-time">
                {failedRow
                  ? "Failed"
                  : automation.lastRunStatus === "running" && startedAt
                    ? formatRunningDurationMs(Math.max(0, now - startedAt))
                    : "Queued"}
              </span>
              {failedRow && automation.lastRunId
                && props.desktopApi?.openAutomationRunWindow ? (
                <button
                  className="live-strip__item-action"
                  type="button"
                  onClick={() =>
                    void props.desktopApi?.openAutomationRunWindow?.({
                      automationId: automation.id,
                      runId: automation.lastRunId!,
                      title: automation.name,
                    })
                  }
                >
                  Why?
                </button>
              ) : null}
              {failedRow ? (
                <button
                  aria-label={`Dismiss failed automation ${automation.name}`}
                  className="live-strip__item-action"
                  type="button"
                  onClick={() => dismiss(automation)}
                >
                  Dismiss
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
