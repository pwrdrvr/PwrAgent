import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type {
  DecisionsRailBatch,
  DecisionsRailItem,
  DecisionsRailItemFilter,
} from "@pwragent/shared/decisions-rail";
import { CloseIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useModalDialog } from "../../../lib/useModalDialog";
import {
  decisionAnswerText,
  decisionBatchStatusLabel,
  decisionBatchTone,
  decisionProviderLabel,
  formatDecisionClock,
  formatDecisionDuration,
  formatDecisionProbability,
  formatDecisionRate,
  isDecisionBatchRunning,
} from "./decisions-format";
import { RailStatusChip } from "./RailStatusChip";

const PAGE_SIZE = 100;
const RUNNING_POLL_MS = 2_000;

const FILTERS: Array<{ id: DecisionsRailItemFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "succeeded", label: "Succeeded" },
  { id: "failed", label: "Failed" },
  { id: "skipped", label: "Skipped" },
];

type DecisionBatchDetailsModalProps = {
  /** The batch as the tab last read it; the dialog refreshes its own copy. */
  batch: DecisionsRailBatch;
  desktopApi?: Pick<DesktopApi, "readDecisionsRailBatch" | "actOnDecisionsRailBatch" | "openDecisionsRailResults">;
  now: number;
  thread: { backend: string; threadId: string };
  /** The batch changed state here (Stop or Cancel); the tab should read again. */
  onChanged: () => void;
  onClose: () => void;
};

/**
 * One batch: its totals, its items in input order with the input preview,
 * answers and latency, and Stop and Cancel while it runs. Opened from a
 * batch row on the Decisions tab, like a sub-agent's details.
 */
export function DecisionBatchDetailsModal(props: DecisionBatchDetailsModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentRef = useModalDialog({ onClose: props.onClose, initialFocus: closeRef });
  const [filter, setFilter] = useState<DecisionsRailItemFilter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [page, setPage] = useState<{ key: string; batch: DecisionsRailBatch; items: DecisionsRailItem[]; nextFrom?: number }>();
  const [loadError, setLoadError] = useState(false);
  const [acting, setActing] = useState<"stop" | "cancel">();
  const [actionError, setActionError] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);
  const tabsId = useId();
  const read = props.desktopApi?.readDecisionsRailBatch;
  const { backend, threadId } = props.thread;
  const batchId = props.batch.batchId;
  const batch = page?.batch ?? props.batch;
  const running = isDecisionBatchRunning(batch);

  useEffect(() => {
    if (!read) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pageKey = `${filter}:${limit}`;
    // Until a read says otherwise, the batch is as running as the tab last
    // saw it, so a failed read retries instead of freezing the dialog.
    let stillRunning = isDecisionBatchRunning(props.batch);
    const load = async (): Promise<void> => {
      try {
        const next = await read({ backend, threadId, batchId, status: filter, from: 0, limit });
        stillRunning = isDecisionBatchRunning(next.batch);
        if (!disposed) {
          setPage({ key: pageKey, batch: next.batch, items: next.items, ...(next.nextFrom !== undefined ? { nextFrom: next.nextFrom } : {}) });
          setLoadError(false);
        }
      } catch {
        if (!disposed) setLoadError(true);
      } finally {
        if (!disposed && stillRunning) timer = setTimeout(() => { void load(); }, RUNNING_POLL_MS);
      }
    };
    void load();
    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
    };
    // props.batch seeds the first poll only; the dialog's own reads take over.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, batchId, filter, limit, read, refreshToken, threadId]);

  const act = async (action: "stop" | "cancel"): Promise<void> => {
    const run = props.desktopApi?.actOnDecisionsRailBatch;
    if (!run) return;
    setActing(action);
    setActionError(undefined);
    try {
      await run({ backend, threadId, batchId, action });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not stop the batch.");
    } finally {
      setActing(undefined);
      props.onChanged();
      // Read again now rather than at the next poll, so the state moves at once.
      setRefreshToken((token) => token + 1);
    }
  };
  const openResults = async (): Promise<void> => {
    const open = props.desktopApi?.openDecisionsRailResults;
    if (!open) return;
    setOpenError(undefined);
    try {
      const result = await open({ backend, threadId, batchId });
      if (!result.opened) setOpenError(result.error ?? "Couldn't open the results file.");
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : "Couldn't open the results file.");
    }
  };
  const selectFilter = (next: DecisionsRailItemFilter): void => {
    setFilter(next);
    setLimit(PAGE_SIZE);
  };
  const handleFilterKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
    const current = FILTERS.findIndex((entry) => entry.id === filter);
    const next = event.key === "ArrowRight"
      ? (current + 1) % FILTERS.length
      : event.key === "ArrowLeft"
        ? (current - 1 + FILTERS.length) % FILTERS.length
        : event.key === "Home" ? 0 : FILTERS.length - 1;
    event.preventDefault();
    selectFilter(FILTERS[next]!.id);
    document.getElementById(`${tabsId}-${FILTERS[next]!.id}`)?.focus();
  };

  const counts: Record<DecisionsRailItemFilter, number> = {
    all: batch.finished,
    succeeded: batch.succeeded,
    failed: batch.failed,
    skipped: batch.skipped,
  };
  // A longer page keeps showing the shorter one while it loads; another
  // filter's rows never show under this one.
  const items = page?.key.startsWith(`${filter}:`) ? page.items : undefined;
  const tone = decisionBatchTone(batch);
  const runtime = [decisionProviderLabel(batch.provider), batch.model].filter(Boolean).join(" · ");
  const reason = batch.stoppedBy
    ? batch.stoppedBy.message
    : batch.state === "cancelled" && batch.cancelReason
      ? `Cancelled: ${batch.cancelReason}.`
      : undefined;

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="subagent-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Decision batch: ${batch.name} v${batch.version}`}
      onClick={props.onClose}
    >
      <div
        ref={contentRef}
        className="subagent-modal__content decisions-modal__content"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="subagent-modal__head">
          <div className="subagent-modal__identity">
            <p className="subagent-modal__status-line">
              <RailStatusChip tone={tone} alert={tone === "error"} blink={running && !batch.stopping}>
                {decisionBatchStatusLabel(batch)}
              </RailStatusChip>
              {batch.background ? <span className="decisions-panel__tag">background</span> : null}
            </p>
            <h2 className="subagent-modal__title">
              {batch.name} v{batch.version}
            </h2>
            <p className="rail-card__runtime">
              <span className="rail-card__provider-chip">{runtime}</span>
              <span className="rail-card__model">
                started {formatDecisionClock(batch.startedAt ?? batch.createdAt, props.now)}
              </span>
            </p>
          </div>
          <div className="subagent-modal__actions">
            {running && props.desktopApi?.actOnDecisionsRailBatch ? (
              <>
                <button
                  type="button"
                  className="button button--ghost"
                  disabled={acting !== undefined || batch.stopping}
                  onClick={() => void act("stop")}
                >
                  {acting === "stop" || batch.stopping ? "Stopping…" : "Stop"}
                </button>
                <button
                  type="button"
                  className="button button--ghost decisions-modal__cancel"
                  disabled={acting !== undefined}
                  onClick={() => void act("cancel")}
                >
                  {acting === "cancel" ? "Cancelling…" : "Cancel"}
                </button>
              </>
            ) : null}
            <button
              type="button"
              ref={closeRef}
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
          <section className="subagent-modal__section">
            <dl className="decisions-modal__facts">
              <div>
                <dt>Items</dt>
                <dd>{batch.finished} / {batch.count}</dd>
              </div>
              <div>
                <dt>Succeeded</dt>
                <dd>{batch.succeeded}</dd>
              </div>
              <div>
                <dt>Failed</dt>
                <dd>{batch.failed}</dd>
              </div>
              <div>
                <dt>Wall time</dt>
                <dd>{batch.wallMs !== undefined ? formatDecisionDuration(batch.wallMs) : "—"}</dd>
              </div>
              <div>
                <dt>Throughput</dt>
                <dd>{batch.itemsPerSecond !== undefined ? formatDecisionRate(batch.itemsPerSecond) : "—"}</dd>
              </div>
              <div>
                <dt>Mean latency</dt>
                <dd>{batch.latency ? formatDecisionDuration(batch.latency.meanMs) : "—"}</dd>
              </div>
              <div>
                <dt>Max latency</dt>
                <dd>{batch.latency ? formatDecisionDuration(batch.latency.maxMs) : "—"}</dd>
              </div>
            </dl>
            {reason ? <p className="decisions-modal__reason">{reason}</p> : null}
            {actionError ? <p className="rail-card__error" role="alert">{actionError}</p> : null}
          </section>

          <section className="subagent-modal__section">
            <div className="decisions-modal__toolbar">
              <div
                aria-label="Show items"
                aria-orientation="horizontal"
                className="subagent-lens-switch decisions-modal__filters"
                role="tablist"
                onKeyDown={handleFilterKeyDown}
              >
                {FILTERS.map((entry) => (
                  <button
                    aria-controls={`${tabsId}-items`}
                    aria-selected={filter === entry.id}
                    className="subagent-lens-switch__button"
                    id={`${tabsId}-${entry.id}`}
                    key={entry.id}
                    role="tab"
                    tabIndex={filter === entry.id ? 0 : -1}
                    type="button"
                    onClick={() => selectFilter(entry.id)}
                  >
                    <span>{entry.label}</span>{" "}
                    <span className="subagent-lens-switch__count">{counts[entry.id]}</span>
                  </button>
                ))}
              </div>
              {batch.hasResultsFile && props.desktopApi?.openDecisionsRailResults ? (
                <button type="button" className="button button--ghost" onClick={() => void openResults()}>
                  Open results file
                </button>
              ) : null}
            </div>
            {openError ? <p className="rail-card__error" role="alert">{openError}</p> : null}
            <div
              aria-labelledby={`${tabsId}-${filter}`}
              className="decisions-modal__items"
              id={`${tabsId}-items`}
              role="tabpanel"
            >
              {items === undefined ? (
                <p className="subagent-modal__body-text subagent-modal__body-text--empty">
                  {loadError ? "Couldn't read this batch's items." : "Loading items…"}
                </p>
              ) : items.length === 0 ? (
                <p className="subagent-modal__body-text subagent-modal__body-text--empty">
                  {filter === "all" ? "No item has finished yet." : `No ${filter} items.`}
                </p>
              ) : (
                <table className="decisions-items">
                  <thead>
                    <tr>
                      <th scope="col" className="decisions-items__index">#</th>
                      <th scope="col">Input (preview)</th>
                      <th scope="col">Answers</th>
                      <th scope="col" className="decisions-items__latency">Latency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((item) => <ItemRow key={item.index} item={item} />)}
                  </tbody>
                </table>
              )}
            </div>
            {page?.nextFrom !== undefined ? (
              <button
                type="button"
                className="button button--ghost decisions-modal__more"
                onClick={() => setLimit((current) => Math.min(current + PAGE_SIZE, 500))}
                disabled={limit >= 500}
              >
                {limit >= 500 ? "Showing the first 500; open the results file for the rest" : "Show more items"}
              </button>
            ) : null}
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ItemRow({ item }: { item: DecisionsRailItem }) {
  return (
    <tr className={item.ok ? undefined : "decisions-items__row--failed"}>
      <td className="decisions-items__index">{item.index}</td>
      <td className="decisions-items__input">
        {item.inputRedacted ? (
          <span className="decisions-items__muted">Hidden: the input looked like it held a credential.</span>
        ) : item.inputPreview !== undefined ? (
          <code>{item.inputPreview}{item.inputTruncated ? "…" : ""}</code>
        ) : (
          <span className="decisions-items__muted">—</span>
        )}
      </td>
      <td className="decisions-items__answers">
        {item.ok ? (
          item.answers && item.answers.length > 0 ? (
            <ul>
              {item.answers.map((answer, index) => (
                <li key={`${answer.name ?? answer.type}:${index}`}>
                  <span>{decisionAnswerText(answer)}</span>
                  {answer.probability !== undefined ? (
                    <span className="decisions-items__probability">{formatDecisionProbability(answer.probability)}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <span className="decisions-items__muted">No answers in the response.</span>
          )
        ) : (
          <span className="decisions-items__error">
            <span className="decisions-items__code">{item.code}</span> {item.message}
          </span>
        )}
      </td>
      <td className="decisions-items__latency">
        {item.durationMs !== undefined ? formatDecisionDuration(item.durationMs) : "—"}
      </td>
    </tr>
  );
}
