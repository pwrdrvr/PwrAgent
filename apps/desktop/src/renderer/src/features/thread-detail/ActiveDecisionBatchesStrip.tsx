import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { DecisionsRailBatch } from "@pwragent/shared/decisions-rail";
import type { NavigationThreadSummary } from "@pwragent/shared/contracts/navigation";
import { SignalCount } from "../../components/SignalCount";
import type { DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { formatRunningDurationMs } from "../../lib/format-duration";
import { statusPulseRef } from "../../lib/status-pulse";
import { DecisionBatchDetailsModal } from "./context-panels/DecisionBatchDetailsModal";
import { isDecisionBatchEventFor } from "./context-panels/decision-batch-events";
import { decisionBatchTitle, decisionBatchVersionTag, isDecisionBatchRunning } from "./context-panels/decisions-format";
import { useNowWhileActive } from "./context-panels/RailCardTiming";
import { ThinkingScanner } from "./ThinkingScanner";

type DecisionBatchStripApi = Pick<
  DesktopApi,
  | "readActiveDecisionBatches"
  | "onAgentEvent"
  | "actOnDecisionsRailBatch"
  | "readDecisionsRailBatch"
  | "openDecisionsRailResults"
>;

/**
 * Decision batches running on this thread, as a strip above the composer
 * beside the sub-agents one. Batches are not sub-agents: they run in the
 * owner's decisions service, which this reads from memory when the thread
 * changes and whenever the owner announces that a batch moved (start, each
 * tenth, end). A batch an error stopped stays until dismissed; one that
 * finished, was cancelled, or was stopped by the operator leaves. Details
 * opens the batch's dialog, the same one the Decisions tab opens.
 */
export function ActiveDecisionBatchesStrip(props: {
  desktopApi?: DecisionBatchStripApi;
  thread?: NavigationThreadSummary;
}): ReactNode {
  const read = props.desktopApi?.readActiveDecisionBatches;
  const subscribe = props.desktopApi?.onAgentEvent;
  const thread = props.thread;
  const available = Boolean(
    read && thread && !thread.federation?.ref.target && !readRendererFederationTarget(),
  );
  const backend = thread?.source;
  const threadId = thread?.id;
  const threadKey = backend && threadId ? `${backend}:${threadId}` : undefined;
  const [state, setState] = useState<{ key?: string; batches: DecisionsRailBatch[] }>({ batches: [] });
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = useCallback(() => setRefreshToken((token) => token + 1), []);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set());
  // The batch as it was when Details was pressed: the dialog keeps reading
  // it after it finishes and leaves the strip.
  const [details, setDetails] = useState<{ threadKey: string; batch: DecisionsRailBatch }>();
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    if (!available || !read || !backend || !threadId || !threadKey) return;
    let disposed = false;
    read({ backend, threadId })
      .then((next) => { if (!disposed) setState({ key: threadKey, batches: next.batches }); })
      // A failed read keeps the last rows: the strip must not flicker away.
      .catch(() => undefined);
    return () => { disposed = true; };
  }, [available, backend, read, refreshToken, threadId, threadKey]);

  useEffect(() => {
    if (!available || !subscribe || !backend || !threadId) return;
    return subscribe((event) => {
      if (isDecisionBatchEventFor(event, { backend, threadId })) refresh();
    });
  }, [available, backend, refresh, subscribe, threadId]);

  const batches = state.key === threadKey ? state.batches : [];
  const running = batches.filter(isDecisionBatchRunning);
  const failed = batches.filter((batch) => !isDecisionBatchRunning(batch) && !dismissed.has(batch.batchId));
  const visible = [...running, ...failed];
  const now = useNowWhileActive(running.length > 0);
  const detailsBatch = details && details.threadKey === threadKey ? details.batch : undefined;

  if (!available || !backend || !threadId || !threadKey || (visible.length === 0 && !detailsBatch)) return null;

  const stop = async (batch: DecisionsRailBatch): Promise<void> => {
    const act = props.desktopApi?.actOnDecisionsRailBatch;
    if (!act) return;
    setStopping((current) => new Set(current).add(batch.batchId));
    try {
      await act({ backend, threadId, batchId: batch.batchId, action: "stop" });
    } catch {
      // The Decisions tab reports action failures; the strip stays one line tall.
    } finally {
      setStopping((current) => {
        const next = new Set(current);
        next.delete(batch.batchId);
        return next;
      });
      refresh();
    }
  };

  const heading = running.length > 0 ? "Decision batches" : "Stopped decision batches";
  const headingCount = running.length > 0 ? running.length : failed.length;
  const failedNote = running.length > 0 && failed.length > 0 ? `${failed.length} stopped by an error` : undefined;

  // The dialog outlives the batch's row, so it sits beside the strip: once
  // nothing is listed, no empty region stays behind it.
  return (
    <>
      {visible.length > 0 ? (
        <section className="live-strip" aria-label={heading}>
          <div className="live-strip__header">
            <button
              aria-expanded={expanded}
              aria-label={`${heading}, ${headingCount}${failedNote ? `, ${failedNote}` : ""}`}
              className="live-strip__row"
              type="button"
              onClick={() => setExpanded((current) => !current)}
            >
              <span className="live-strip__chevron" aria-hidden="true" />
              <span className="live-strip__label">{heading}</span>{" "}
              <SignalCount
                className="live-strip__count"
                count={headingCount}
                indicator={running.length > 0 ? <ThinkingScanner compact /> : <span className="signal-count__dormant-scanner" />}
                tone={running.length > 0 ? "active" : "idle"}
              />
              {" "}<span className="live-strip__row-spacer" />
              {failedNote ? <span className="live-strip__note">{failedNote}</span> : null}
            </button>
          </div>
          {expanded ? (
            <ul className="live-strip__list">
              {visible.map((batch) => {
                const failedRow = !isDecisionBatchRunning(batch);
                const label = [decisionBatchTitle(batch), decisionBatchVersionTag(batch)].filter(Boolean).join(" ");
                const progress = `${batch.finished}/${batch.count}`;
                const elapsed = formatRunningDurationMs(Math.max(0, now - (batch.startedAt ?? batch.createdAt)));
                return (
                  <li
                    className={`live-strip__item${failedRow ? " live-strip__item--failed" : ""}`}
                    key={batch.batchId}
                  >
                    <span
                      aria-hidden="true"
                      className={failedRow ? "status-dot status-dot--error" : "status-dot status-dot--active status-dot--blink"}
                      ref={failedRow ? undefined : statusPulseRef}
                    />
                    <span className="live-strip__item-text" title={label}>
                      {label} · {progress}
                      {failedRow ? ` · ${batch.stoppedBy?.code ?? "stopped"}` : ` · ${elapsed}`}
                    </span>
                    <span className="live-strip__item-time">{failedRow ? "Failed" : batch.stopping ? "Stopping" : "Running"}</span>
                    <button
                      aria-label={`Details for decision batch: ${label}`}
                      className="live-strip__item-action"
                      type="button"
                      onClick={() => setDetails({ threadKey, batch })}
                    >
                      Details
                    </button>
                    <span className="live-strip__item-slot">
                      {failedRow ? (
                        <button
                          aria-label={`Dismiss decision batch: ${label}`}
                          className="live-strip__item-action"
                          type="button"
                          onClick={() => setDismissed((current) => new Set(current).add(batch.batchId))}
                        >
                          Dismiss
                        </button>
                      ) : props.desktopApi?.actOnDecisionsRailBatch ? (
                        <button
                          aria-label={`Stop decision batch: ${label}`}
                          className="live-strip__item-action live-strip__item-action--danger"
                          disabled={stopping.has(batch.batchId) || batch.stopping}
                          type="button"
                          onClick={() => void stop(batch)}
                        >
                          {stopping.has(batch.batchId) || batch.stopping ? "Stopping…" : "Stop"}
                        </button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
        </section>
      ) : null}
      {detailsBatch ? (
        <DecisionBatchDetailsModal
          batch={detailsBatch}
          desktopApi={props.desktopApi}
          now={now}
          thread={{ backend, threadId }}
          onChanged={refresh}
          onClose={() => setDetails(undefined)}
        />
      ) : null}
    </>
  );
}
