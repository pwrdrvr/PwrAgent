import { useState, type ReactNode } from "react";
import type {
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { isTerminalSubAgent } from "./context-panels/subagent-format";
import { useNowWhileActive } from "./context-panels/RailCardTiming";
import { ThinkingScanner } from "./ThinkingScanner";
import { formatRunningDurationMs } from "../../lib/format-duration";
import type { DesktopApi } from "../../lib/desktop-api";

/**
 * `subAgentTone` treats both spellings as an error state, but
 * `isTerminalSubAgent` only lists `"failure"` — a record that reports
 * `"failed"` without a completion boundary would otherwise read as still
 * running here and blink at the operator forever.
 */
function isFailedSubAgent(subAgent: ThreadSubAgentSummary): boolean {
  return subAgent.status === "failed" || subAgent.status === "failure";
}

function isRunningSubAgent(subAgent: ThreadSubAgentSummary): boolean {
  return !isTerminalSubAgent(subAgent) && !isFailedSubAgent(subAgent);
}

/**
 * Active sub-agents, as a compact strip above the composer.
 *
 * Covers every producer at once — PwrAgent task monitors, code review (which
 * is also the ACP path), Codex's own `spawnAgent`, and the title helper —
 * because all four persist the same `ThreadSubAgentSummary` through one store.
 * Reads the navigation snapshot the renderer already holds; adds no IPC and no
 * polling of its own.
 *
 * The rail panel remains the full-detail surface. This is a presence indicator
 * with a Stop button, deliberately not a second copy of the card.
 */
export function ActiveSubAgentsStrip(props: {
  desktopApi?: DesktopApi;
  onRefreshNavigation?: () => Promise<void>;
  thread?: NavigationThreadSummary;
}): ReactNode {
  const [dismissedFailures, setDismissedFailures] = useState<Set<string>>(
    () => new Set(),
  );
  const [stoppingIds, setStoppingIds] = useState<Set<string>>(() => new Set());

  const subAgents = props.thread?.subAgents ?? [];
  const running = subAgents.filter(isRunningSubAgent);
  // Successful and cancelled sub-agents leave immediately — the sidebar and the
  // rail panel already hold them. Failures linger until dismissed: the strip
  // vanishing is how an operator misses one, and neither of those surfaces is
  // in their eyeline while they are typing.
  const failed = subAgents.filter(
    (subAgent) =>
      isFailedSubAgent(subAgent) && !dismissedFailures.has(subAgent.monitorId),
  );
  const visible = [...running, ...failed];

  // Seeded once, on mount: one or two rows cost almost nothing and saying what
  // is running is the point, while three or more is the wall this strip exists
  // to avoid. A later count change must not yank the disclosure out from under
  // an operator who already made a choice, so this never re-evaluates.
  const [expanded, setExpanded] = useState(() => visible.length <= 2);

  const now = useNowWhileActive(running.length > 0);

  if (visible.length === 0) {
    return null;
  }

  const dismissFailure = (monitorId: string): void => {
    setDismissedFailures((current) => new Set(current).add(monitorId));
  };

  const dismissAllFailures = (): void => {
    setDismissedFailures((current) => {
      const next = new Set(current);
      for (const subAgent of failed) {
        next.add(subAgent.monitorId);
      }
      return next;
    });
  };

  // A thread that accumulated a dozen failures reads as "13 active sub-agents"
  // under an Active heading with nothing running, which is simply false. The
  // heading follows what is actually in the list.
  const heading = running.length > 0 ? "Active sub-agents" : "Failed sub-agents";

  const stopSubAgent = async (
    subAgent: ThreadSubAgentSummary,
  ): Promise<void> => {
    const thread = props.thread;
    if (!thread || !props.desktopApi?.stopSubAgent) return;
    setStoppingIds((current) => new Set(current).add(subAgent.monitorId));
    try {
      await props.desktopApi.stopSubAgent({
        backend: thread.source,
        ...(thread.federation?.ref.target
          ? { federationTarget: thread.federation.ref.target }
          : {}),
        threadId: thread.id,
        monitorId: subAgent.monitorId,
      });
      await props.onRefreshNavigation?.();
    } catch {
      // The rail panel owns error reporting for stop failures; surfacing a
      // message here would push the composer down, which is the one thing this
      // strip must not do.
    } finally {
      setStoppingIds((current) => {
        const next = new Set(current);
        next.delete(subAgent.monitorId);
        return next;
      });
    }
  };

  return (
    <section className="live-strip" aria-label={heading}>
      <div className="live-strip__header">
        <button
          aria-expanded={expanded}
          aria-label={`${heading} (${visible.length})`}
          className="live-strip__row"
          type="button"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="live-strip__chevron" aria-hidden="true" />
          <span className="live-strip__label">{heading}</span>
          <span className="live-strip__count">{visible.length}</span>
          <span className="live-strip__row-spacer" />
          {running.length > 0 ? <ThinkingScanner compact /> : null}
        </button>
        {/* Clearing failures one at a time is fine for one or two and a chore
            at a dozen. Only ever clears failures — a running sub-agent is
            never swept up by it. */}
        {failed.length > 1 ? (
          <button
            aria-label={`Dismiss all ${failed.length} failed sub-agents`}
            className="live-strip__item-action live-strip__dismiss-all"
            type="button"
            onClick={dismissAllFailures}
          >
            Dismiss all
          </button>
        ) : null}
      </div>
      {expanded ? (
        <ul className="live-strip__list">
          {visible.map((subAgent) => {
            const failedRow = isFailedSubAgent(subAgent);
            const stopping = stoppingIds.has(subAgent.monitorId);
            const canStop =
              subAgent.status === "running"
              && Boolean(subAgent.monitorThreadId)
              && Boolean(subAgent.monitorTurnId)
              && Boolean(props.desktopApi?.stopSubAgent);
            return (
              <li
                className={`live-strip__item${
                  failedRow ? " live-strip__item--failed" : ""
                }`}
                key={subAgent.monitorId}
              >
                <span
                  aria-hidden="true"
                  className={
                    failedRow
                      ? "status-dot status-dot--error"
                      : "status-dot status-dot--active status-dot--blink"
                  }
                />
                <span className="live-strip__item-text" title={subAgent.task}>
                  {subAgent.task}
                </span>
                {/* Never color alone: the row states its outcome in words. */}
                <span className="live-strip__item-time">
                  {failedRow
                    ? "Failed"
                    : formatRunningDurationMs(
                        Math.max(0, now - subAgent.createdAt),
                      )}
                </span>
                {/* Both controls name their target. The visible text stays a
                    single word so the row does not grow, but an unqualified
                    "Stop" would be read out identically for every row by a
                    screen reader — and page-wide `name: "Stop"` is the
                    established E2E handle for the composer's stop-the-turn
                    button, which this must not shadow. */}
                {failedRow ? (
                  <button
                    aria-label={`Dismiss failed sub-agent: ${subAgent.task}`}
                    className="live-strip__item-action"
                    type="button"
                    onClick={() => dismissFailure(subAgent.monitorId)}
                  >
                    Dismiss
                  </button>
                ) : canStop ? (
                  <button
                    aria-label={`Stop sub-agent: ${subAgent.task}`}
                    className="live-strip__item-action live-strip__item-action--danger"
                    disabled={stopping}
                    type="button"
                    onClick={() => void stopSubAgent(subAgent)}
                  >
                    {stopping ? "Stopping…" : "Stop"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
