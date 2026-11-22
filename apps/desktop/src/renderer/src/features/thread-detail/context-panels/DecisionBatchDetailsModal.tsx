import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type {
  DecisionsRailAnswer,
  DecisionsRailBatch,
  DecisionsRailDefinition,
  DecisionsRailItem,
  DecisionsRailItemFilter,
} from "@pwragent/shared/decisions-rail";
import { CloseIcon } from "../../../icons";
import type { DesktopApi } from "../../../lib/desktop-api";
import { useModalDialog } from "../../../lib/useModalDialog";
import {
  parseInputPreview,
  previewInline,
  previewSummary,
  type PreviewValue,
} from "./decision-input-preview";
import {
  DECISION_LOW_CONFIDENCE,
  decisionAnswerText,
  decisionBatchStatusLabel,
  decisionBatchTitle,
  decisionBatchTone,
  formatDecisionClock,
  formatDecisionDuration,
  formatDecisionProbability,
  formatDecisionRate,
  isDecisionBatchRunning,
} from "./decisions-format";
import { BatchTitle } from "./DecisionBatchTitle";
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

type Page = {
  key: string;
  batch: DecisionsRailBatch;
  definition?: DecisionsRailDefinition;
  items: DecisionsRailItem[];
  nextFrom?: number;
};

/**
 * One batch, for review: its totals, the prompt every item shared, and its
 * items as a list beside the selected item's answers and input. Arrow keys
 * (or j and k) move through the list, so a long batch can be read from the
 * keyboard. Stop and Cancel show while it runs. Opened from a batch card on
 * the Decisions tab.
 */
export function DecisionBatchDetailsModal(props: DecisionBatchDetailsModalProps) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentRef = useModalDialog({ onClose: props.onClose, initialFocus: closeRef });
  const [filter, setFilter] = useState<DecisionsRailItemFilter>("all");
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [page, setPage] = useState<Page>();
  const [loadError, setLoadError] = useState(false);
  const [acting, setActing] = useState<"stop" | "cancel">();
  const [actionError, setActionError] = useState<string>();
  const [openError, setOpenError] = useState<string>();
  const [refreshToken, setRefreshToken] = useState(0);
  const [selected, setSelected] = useState<number>();
  const baseId = useId();
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
          setPage({
            key: pageKey,
            batch: next.batch,
            ...(next.definition ? { definition: next.definition } : {}),
            items: next.items,
            ...(next.nextFrom !== undefined ? { nextFrom: next.nextFrom } : {}),
          });
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
    document.getElementById(`${baseId}-${FILTERS[next]!.id}`)?.focus();
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
  // The selection follows the list: a filter that hides the selected item
  // selects the first one it shows.
  const current = items?.find((item) => item.index === selected) ?? items?.[0];
  const position = current && items ? items.indexOf(current) : -1;
  const move = (delta: number): void => {
    if (!items || items.length === 0) return;
    const next = items[Math.min(items.length - 1, Math.max(0, position + delta))]!;
    setSelected(next.index);
    document.getElementById(`${baseId}-item-${next.index}`)?.scrollIntoView?.({ block: "nearest" });
  };
  const handleListKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!items || items.length === 0) return;
    const delta = event.key === "ArrowDown" || event.key === "j"
      ? 1
      : event.key === "ArrowUp" || event.key === "k"
        ? -1
        : event.key === "Home"
          ? -items.length
          : event.key === "End" ? items.length : 0;
    if (delta === 0) return;
    event.preventDefault();
    move(delta);
  };

  const tone = decisionBatchTone(batch);
  const reason = batch.stoppedBy
    ? batch.stoppedBy.message
    : batch.state === "cancelled" && batch.cancelReason
      ? `Cancelled: ${batch.cancelReason}.`
      : undefined;
  const facts = [
    `${batch.finished}/${batch.count} items`,
    `${batch.succeeded} succeeded`,
    `${batch.failed} failed`,
    ...(batch.skipped > 0 ? [`${batch.skipped} skipped`] : []),
    ...(batch.wallMs !== undefined ? [`${formatDecisionDuration(batch.wallMs)} wall`] : []),
    ...(batch.itemsPerSecond !== undefined ? [formatDecisionRate(batch.itemsPerSecond)] : []),
    ...(batch.latency ? [`mean ${formatDecisionDuration(batch.latency.meanMs)}`, `max ${formatDecisionDuration(batch.latency.maxMs)}`] : []),
    `started ${formatDecisionClock(batch.startedAt ?? batch.createdAt, props.now)}`,
  ];

  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className="subagent-modal"
      role="dialog"
      aria-modal="true"
      aria-label={`Decision batch: ${decisionBatchTitle(batch)}${batch.adHoc ? "" : ` v${batch.version}`}`}
      onClick={props.onClose}
    >
      <div
        ref={contentRef}
        className="subagent-modal__content decisions-modal__content"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="subagent-modal__head decisions-modal__head">
          <div className="subagent-modal__identity">
            <p className="subagent-modal__status-line">
              <RailStatusChip tone={tone} alert={tone === "error"} blink={running && !batch.stopping}>
                {decisionBatchStatusLabel(batch)}
              </RailStatusChip>
              {batch.background ? <span className="decisions-panel__tag">background</span> : null}
            </p>
            <h2 className="subagent-modal__title decisions-modal__title">
              <BatchTitle batch={batch} model={batch.model} className="decisions-modal__title-line" />
            </h2>
            <p className="decisions-modal__facts">
              {facts.map((fact) => <span key={fact}>{fact}</span>)}
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
            {batch.hasResultsFile && props.desktopApi?.openDecisionsRailResults ? (
              <button type="button" className="button button--ghost" onClick={() => void openResults()}>
                Open results file
              </button>
            ) : null}
            <button
              type="button"
              ref={closeRef}
              className="subagent-modal__close"
              aria-label="Close"
              onClick={props.onClose}
            >
              <CloseIcon size={18} aria-hidden="true" />
            </button>
          </div>
        </div>

        {reason || actionError || openError ? (
          <div className="decisions-modal__notes">
            {reason ? <p className="decisions-modal__reason">{reason}</p> : null}
            {actionError ? <p className="rail-card__error" role="alert">{actionError}</p> : null}
            {openError ? <p className="rail-card__error" role="alert">{openError}</p> : null}
          </div>
        ) : null}

        <PromptSection definition={page?.definition} loaded={page !== undefined} />

        <div className="decisions-review">
          <div className="decisions-review__list">
            <div
              aria-label="Show items"
              aria-orientation="horizontal"
              className="subagent-lens-switch decisions-modal__filters"
              role="tablist"
              onKeyDown={handleFilterKeyDown}
            >
              {FILTERS.map((entry) => (
                <button
                  aria-controls={`${baseId}-items`}
                  aria-selected={filter === entry.id}
                  className="subagent-lens-switch__button"
                  id={`${baseId}-${entry.id}`}
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
            <div aria-labelledby={`${baseId}-${filter}`} className="decisions-review__items" id={`${baseId}-items`} role="tabpanel">
              {items === undefined ? (
                <p className="decisions-review__empty">
                  {loadError ? "Couldn't read this batch's items." : "Loading items…"}
                </p>
              ) : items.length === 0 ? (
                <p className="decisions-review__empty">
                  {filter === "all" ? "No item has finished yet." : `No ${filter} items.`}
                </p>
              ) : (
                <div
                  aria-activedescendant={current ? `${baseId}-item-${current.index}` : undefined}
                  aria-label="Items"
                  className="decisions-review__listbox"
                  role="listbox"
                  tabIndex={0}
                  onKeyDown={handleListKeyDown}
                >
                  {items.map((item) => (
                    <ItemRow
                      id={`${baseId}-item-${item.index}`}
                      item={item}
                      key={item.index}
                      selected={item === current}
                      onSelect={() => setSelected(item.index)}
                    />
                  ))}
                </div>
              )}
              {page?.nextFrom !== undefined && items !== undefined ? (
                <button
                  type="button"
                  className="button button--ghost decisions-modal__more"
                  onClick={() => setLimit((value) => Math.min(value + PAGE_SIZE, 500))}
                  disabled={limit >= 500}
                >
                  {limit >= 500 ? "Showing the first 500; open the results file for the rest" : "Show more items"}
                </button>
              ) : null}
            </div>
          </div>
          <div className="decisions-review__detail" aria-live="polite">
            {current && items ? (
              <ItemDetail
                item={current}
                canPrevious={position > 0}
                canNext={position < items.length - 1}
                onPrevious={() => move(-1)}
                onNext={() => move(1)}
              />
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** The prompt every item shared: the cached prefix and each question with its allowed answers. */
function PromptSection(props: { definition?: DecisionsRailDefinition; loaded: boolean }) {
  if (!props.loaded) return null;
  const definition = props.definition;
  if (!definition) {
    return (
      <p className="decisions-prompt decisions-prompt--missing">
        This batch ran before PwrAgent kept each batch's prompt.
      </p>
    );
  }
  return (
    <details className="decisions-prompt" open>
      <summary>Prompt · the same for every item</summary>
      <div className="decisions-prompt__grid">
        {definition.prefix ? (
          <div className="decisions-prompt__part">
            <h3 className="decisions-prompt__label">Shared context</h3>
            <p className="decisions-prompt__prefix" tabIndex={0}>{definition.prefix}</p>
          </div>
        ) : null}
        <div className="decisions-prompt__part">
          <h3 className="decisions-prompt__label">
            {definition.questions.length === 1 ? "Question" : `Questions (${definition.questions.length})`}
          </h3>
          <ul className="decisions-prompt__questions">
            {definition.questions.map((question, index) => (
              <li key={`${question.name ?? question.type}:${index}`} className="decisions-prompt__question">
                <p className="decisions-prompt__question-head">
                  <span className="decisions-prompt__question-name">{question.name ?? `Question ${index + 1}`}</span>
                  <span className="decisions-panel__tag">{question.type === "predicate" ? "yes/no" : question.type}</span>
                </p>
                <p className="decisions-prompt__instructions">{question.instructions}</p>
                {question.options && question.options.length > 0 ? (
                  <ul className="decisions-prompt__options">
                    {question.options.map((option) => (
                      <li key={option.label}>
                        <span className="decisions-prompt__option">{option.label}</span>
                        {option.description ? <span className="decisions-prompt__option-text">{option.description}</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </details>
  );
}

function leadingAnswer(item: DecisionsRailItem): DecisionsRailAnswer | undefined {
  return item.answers?.find((answer) => answer.value !== undefined) ?? item.answers?.[0];
}

function isLowConfidence(answer: DecisionsRailAnswer | undefined): boolean {
  return answer?.probability !== undefined && answer.probability < DECISION_LOW_CONFIDENCE;
}

function ItemRow(props: { id: string; item: DecisionsRailItem; selected: boolean; onSelect: () => void }) {
  const { item } = props;
  const answer = item.ok ? leadingAnswer(item) : undefined;
  const summary = item.inputRedacted
    ? "Input hidden"
    : item.inputPreview !== undefined
      ? previewSummary(parseInputPreview(item.inputPreview, item.inputTruncated === true), item.inputPreview)
      : "—";
  return (
    <div
      aria-selected={props.selected}
      className={`decisions-review__row${props.selected ? " decisions-review__row--selected" : ""}`}
      id={props.id}
      role="option"
      onClick={props.onSelect}
    >
      <span className="decisions-review__index">{item.index}</span>
      <span className="decisions-review__summary">{summary}</span>
      {item.ok ? (
        answer?.value !== undefined ? (
          <span className={`decisions-review__chip${isLowConfidence(answer) ? " decisions-review__chip--low" : ""}`}>
            {answer.value}
            {answer.probability !== undefined ? ` · ${formatDecisionProbability(answer.probability)}` : ""}
          </span>
        ) : null
      ) : (
        <span className="decisions-review__chip decisions-review__chip--failed">{item.code}</span>
      )}
    </div>
  );
}

function ItemDetail(props: {
  item: DecisionsRailItem;
  canPrevious: boolean;
  canNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  const { item } = props;
  const parsed = item.inputPreview !== undefined ? parseInputPreview(item.inputPreview, item.inputTruncated === true) : undefined;
  return (
    <section className="decisions-detail" aria-label={`Item ${item.index}`}>
      <div className="decisions-detail__head">
        <h3>
          Item {item.index}
          {item.durationMs !== undefined ? (
            <span className="decisions-detail__latency"> · {formatDecisionDuration(item.durationMs)}</span>
          ) : null}
        </h3>
        <div className="decisions-detail__nav">
          <button type="button" className="button button--ghost" disabled={!props.canPrevious} onClick={props.onPrevious}>
            Previous
          </button>
          <button type="button" className="button button--ghost" disabled={!props.canNext} onClick={props.onNext}>
            Next
          </button>
        </div>
      </div>

      <div className="decisions-detail__part">
        <h4 className="decisions-prompt__label">{item.ok ? "Answers" : "Error"}</h4>
        {item.ok ? (
          item.answers && item.answers.length > 0 ? (
            <ul className="decisions-detail__answers">
              {item.answers.map((answer, index) => (
                <AnswerRow key={`${answer.name ?? answer.type}:${index}`} answer={answer} />
              ))}
            </ul>
          ) : (
            <p className="decisions-detail__muted">No answers in the response.</p>
          )
        ) : (
          <p className="decisions-detail__error">
            <span className="decisions-items__code">{item.code}</span> {item.message}
          </p>
        )}
      </div>

      <div className="decisions-detail__part">
        <h4 className="decisions-prompt__label">Input</h4>
        {item.inputRedacted ? (
          <p className="decisions-detail__muted">Hidden: the input looked like it held a credential.</p>
        ) : item.inputPreview === undefined ? (
          <p className="decisions-detail__muted">No preview was kept for this item.</p>
        ) : parsed ? (
          <InputValue value={parsed} depth={0} />
        ) : (
          <code className="decisions-detail__raw">{item.inputPreview}{item.inputTruncated ? "…" : ""}</code>
        )}
        {item.inputTruncated ? (
          <p className="decisions-detail__muted">The preview stops at 2 KB; the rest of this input is not kept.</p>
        ) : null}
      </div>
    </section>
  );
}

function AnswerRow(props: { answer: DecisionsRailAnswer }) {
  const { answer } = props;
  const name = answer.name ?? answer.type;
  if (answer.type === "refusal" || answer.type === "unavailable" || answer.type === "other" || answer.value === undefined) {
    return (
      <li className="decisions-detail__answer">
        <span className="decisions-detail__answer-name">{name}</span>
        <span className="decisions-detail__muted">{decisionAnswerText(answer)}</span>
      </li>
    );
  }
  const probability = answer.probability;
  return (
    <li className="decisions-detail__answer">
      <span className="decisions-detail__answer-name">{name}</span>
      <span className="decisions-detail__answer-value">
        <strong>{answer.value}</strong>
        {probability !== undefined ? (
          <>
            <span
              className={`decisions-detail__bar${isLowConfidence(answer) ? " decisions-detail__bar--low" : ""}`}
              aria-hidden="true"
            >
              <span style={{ width: `${Math.round(Math.min(1, Math.max(0, probability)) * 100)}%` }} />
            </span>
            <span className="decisions-detail__probability">{formatDecisionProbability(probability)}</span>
          </>
        ) : null}
      </span>
    </li>
  );
}

/** Input as labelled fields: an object's fields one per row, nested two levels, anything deeper on one line. */
function InputValue(props: { value: PreviewValue; depth: number }) {
  const { value } = props;
  switch (value.kind) {
    case "text":
      return <span className="decisions-input__text">{value.text}{value.cut ? "…" : ""}</span>;
    case "scalar":
      return <span className="decisions-input__scalar">{value.text}</span>;
    case "array":
      if (props.depth < 2 && value.items.some((entry) => entry.kind === "object")) {
        return (
          <ol className="decisions-input__list">
            {value.items.map((entry, index) => (
              <li key={index}><InputValue value={entry} depth={props.depth + 1} /></li>
            ))}
            {value.cut ? <li className="decisions-detail__muted">…</li> : null}
          </ol>
        );
      }
      return <span className="decisions-input__scalar">{previewInline(value)}</span>;
    case "object":
      if (props.depth >= 2) return <span className="decisions-input__scalar">{previewInline(value)}</span>;
      return (
        <dl className={props.depth === 0 ? "decisions-input" : "decisions-input decisions-input--nested"}>
          {value.entries.map(([key, field]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd><InputValue value={field} depth={props.depth + 1} /></dd>
            </div>
          ))}
          {value.cut ? (
            <div>
              <dt aria-label="More fields">…</dt>
              <dd className="decisions-detail__muted">cut</dd>
            </div>
          ) : null}
        </dl>
      );
  }
}
