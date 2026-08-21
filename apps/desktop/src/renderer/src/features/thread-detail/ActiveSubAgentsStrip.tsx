import { useState, type ReactNode } from "react";
import type {
  NavigationThreadSummary,
  ThreadSubAgentSummary,
} from "@pwragent/shared";
import { isTerminalSubAgent } from "./context-panels/subagent-format";
import { useNowWhileActive } from "./context-panels/RailCardTiming";
import { SignalCount } from "../../components/SignalCount";
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

/**
 * Waiting on input, not working. It belongs in the strip — arguably more than
 * a healthy run does — but it must not blink an accent dot and count up an
 * elapsed timer as though something were happening.
 */
function isBlockedSubAgent(subAgent: ThreadSubAgentSummary): boolean {
  return subAgent.status === "blocked" && !isTerminalSubAgent(subAgent);
}

function isRunningSubAgent(subAgent: ThreadSubAgentSummary): boolean {
  return (
    !isTerminalSubAgent(subAgent)
    && !isFailedSubAgent(subAgent)
    && !isBlockedSubAgent(subAgent)
  );
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
  const blocked = subAgents.filter(isBlockedSubAgent);
  // Successful and cancelled sub-agents leave immediately — the sidebar and the
  // rail panel already hold them. Failures linger until dismissed: the strip
  // vanishing is how an operator misses one, and neither of those surfaces is
  // in their eyeline while they are typing.
  const failed = subAgents.filter(
    (subAgent) =>
      isFailedSubAgent(subAgent) && !dismissedFailures.has(subAgent.monitorId),
  );
  const visible = [...running, ...blocked, ...failed];

  // One or two rows cost almost nothing and saying what is running is the
  // point; three or more is the wall this strip exists to avoid. A later count
  // change must not yank the disclosure out from under an operator who already
  // made a choice, so this is evaluated exactly once and never again.
  //
  // It has to be seeded on the first render that has ROWS, not on mount. The
  // Composer mounts this component unconditionally and it returns null while
  // empty, so a mount-time seed always read a count of zero and pinned
  // `expanded` to true for the life of the window — the collapse-at-3+ rule
  // never fired in the app, only in tests that rendered straight into a
  // populated state.
  //
  // "Once" means once per appearance, not once per window. The strip emptying
  // is a natural boundary: the next batch is new work and deserves to be sized
  // to itself rather than governed by whatever the session's first batch
  // happened to be.
  const [expanded, setExpanded] = useState(true);
  const [seeded, setSeeded] = useState(false);
  if (!seeded && visible.length > 0) {
    setSeeded(true);
    setExpanded(visible.length <= 2);
  } else if (seeded && visible.length === 0) {
    setSeeded(false);
  }

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

  // The heading and the count must agree, and both must describe what is
  // actually in the list. A thread carrying one live monitor and a dozen old
  // failures is not "13 active sub-agents"; neither is a thread of pure
  // failures "active" at all.
  const activeCount = running.length + blocked.length;
  const heading = activeCount > 0 ? "Active sub-agents" : "Failed sub-agents";
  const headingCount = activeCount > 0 ? activeCount : failed.length;
  const failedNote =
    activeCount > 0 && failed.length > 0 ? `${failed.length} failed` : undefined;

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
          aria-label={`${heading} (${headingCount})${
            failedNote ? `, ${failedNote}` : ""
          }`}
          className="live-strip__row"
          type="button"
          onClick={() => setExpanded((current) => !current)}
        >
          <span className="live-strip__chevron" aria-hidden="true" />
          {/* The sidebar's mark-and-number, not a bordered pill: the same
              statement ("this many, working") must not look like a different
              kind of object in another part of the window.

              The two halves answer different questions, so they read
              different values. The MARK answers "is anything progressing?"
              — only genuine work sweeps, so a strip of blocked or failed
              rows gets the dormant bar. The TONE answers "what is this a
              count of?", which is what the heading and `headingCount`
              already answer: `activeCount` for a live strip, failures
              otherwise. Keying the tone on `running` instead would paint a
              blocked-only strip's count idle grey under an "Active
              sub-agents" heading. */}
          <span className="live-strip__label">{heading}</span>
          <SignalCount
            className="live-strip__count"
            count={headingCount}
            indicator={
              running.length > 0 ? (
                <ThinkingScanner compact />
              ) : (
                <span className="signal-count__dormant-scanner" />
              )
            }
            tone={activeCount > 0 ? "active" : "idle"}
          />
          <span className="live-strip__row-spacer" />
          {/* Trailing, so the tally sits next to the Dismiss all that acts on
              it. Leading, it collided with the count and read as "1 12". */}
          {failedNote ? (
            <span className="live-strip__note">{failedNote}</span>
          ) : null}
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
            const blockedRow = isBlockedSubAgent(subAgent);
            const stopping = stoppingIds.has(subAgent.monitorId);
            const canStop =
              (subAgent.status === "pending"
                || subAgent.status === "running"
                || blockedRow)
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
                      : blockedRow
                        ? "status-dot status-dot--warning"
                        : "status-dot status-dot--active status-dot--blink"
                  }
                />
                <span className="live-strip__item-text" title={subAgent.task}>
                  {subAgent.task}
                </span>
                {/* Never color alone: the row states its state in words, and a
                    blocked row shows no elapsed time because nothing is
                    elapsing — it is waiting on input. */}
                <span className="live-strip__item-time">
                  {failedRow
                    ? "Failed"
                    : blockedRow
                      ? "Blocked"
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
                {/* Always rendered, even when empty. A row without a stoppable
                    monitor turn has no action, and without a reserved slot its
                    state text slid right to the edge while every neighbour's
                    stopped short — the right rail stopped being a column. */}
                <span className="live-strip__item-slot">
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
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
