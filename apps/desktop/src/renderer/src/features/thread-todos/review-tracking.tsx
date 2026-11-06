import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ReviewAutoFixRun,
  ReviewAutoFixStatus,
  ThreadReview,
  ThreadReviewIdentity,
  ThreadReviewItem,
  ThreadReviewResolution,
  UpdateThreadReviewRequest,
} from "@pwragent/shared";
import { BanIcon, CheckIcon, ClockIcon, TodoIcon } from "../../icons";
import { PendingSpinner } from "../../components/PendingSpinner";
import { useDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

const pendingReads = new WeakMap<DesktopApi, Map<string, Promise<unknown>>>();

/**
 * One read per thread at a time, shared by every surface that asks, such as
 * the transcript and its To-do card. `round` names what prompted the read: a
 * change event's time keeps a read that started before the change from
 * answering for it.
 */
function sharedRead<T>(
  api: DesktopApi,
  kind: string,
  identity: ThreadReviewIdentity,
  read: () => Promise<T>,
  round?: number,
): Promise<T> {
  let pending = pendingReads.get(api);
  if (!pending) {
    pending = new Map();
    pendingReads.set(api, pending);
  }
  const key = JSON.stringify([kind, identity.federationTarget?.instanceId, identity.backend, identity.threadId, round]);
  const current = pending.get(key);
  if (current) return current as Promise<T>;
  const request = read().finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

/** The transcript and its To-do card share one read when the same event arrives. */
function readReviews(api: DesktopApi, identity: ThreadReviewIdentity): Promise<ThreadReview[]> {
  return sharedRead(api, "reviews", identity, () => api.listThreadReviews!({ ...identity, status: "all" })
    .then((response) => response.reviews));
}

/**
 * The thread's Auto-fix state from its owner. An owner that predates it does
 * not answer, which reads as no state at all.
 */
function readAutoFix(
  api: DesktopApi,
  identity: ThreadReviewIdentity,
  round: number | undefined,
): Promise<ReviewAutoFixStatus | undefined> {
  return sharedRead(api, "auto-fix", identity, () => api.readReviewAutoFix!(identity)
    .then((response) => response.status)
    .catch(() => undefined), round);
}

/**
 * A thread's Auto-fix state, read from the thread's owner and re-read on its
 * to-do change event: which running reviews are armed, and what each landed
 * review's Auto-fix turn is doing. `disarm` is Don't auto-fix.
 */
export function useReviewAutoFix(identity: ThreadReviewIdentity | undefined) {
  const api = useDesktopApi();
  const instanceId = identity?.federationTarget?.instanceId ?? readRendererFederationTarget()?.instanceId;
  const backend = identity?.backend;
  const threadId = identity?.threadId;
  const [status, setStatus] = useState<ReviewAutoFixStatus>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    setStatus(undefined);
    setError(undefined);
    if (!backend || !threadId || !api?.readReviewAutoFix) return;
    let cancelled = false;
    const target = instanceId ? { federationTarget: { scope: "remote" as const, instanceId } } : {};
    let latest = 0;
    const reload = (round?: number) => {
      const read = ++latest;
      void readAutoFix(api, { backend, threadId, ...target }, round).then((next) => {
        // An earlier read can answer after a later one; keep the later one.
        if (!cancelled && read === latest) setStatus(next);
      });
    };
    reload();
    const unsubscribe = api.onThreadTodosChanged?.((event) => {
      if (event.federationTarget?.instanceId !== instanceId && event.backend !== undefined) return;
      if (event.backend === undefined || (event.backend === backend && event.threadId === threadId)) reload(event.at);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, backend, threadId, instanceId]);
  const disarm = useCallback(async (turnId: string) => {
    if (!backend || !threadId || !api?.disarmReviewAutoFix) return;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.disarmReviewAutoFix({ backend, threadId, turnId,
        ...(instanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
      });
      setStatus(response.status);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [api, backend, threadId, instanceId]);
  return { status, disarm, busy, error };
}

export type ReviewUpdate = (request: Omit<UpdateThreadReviewRequest, "id">) => Promise<void>;

export function useTrackedReview(
  identity: ThreadReviewIdentity | undefined,
  target: { id?: string; sourceKey?: string },
) {
  const desktopApi = useDesktopApi();
  const api = desktopApi;
  const instanceId = identity?.federationTarget?.instanceId ?? readRendererFederationTarget()?.instanceId;
  const [review, setReview] = useState<ThreadReview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const backend = identity?.backend;
  const threadId = identity?.threadId;
  const { id, sourceKey } = target;
  useEffect(() => {
    generation.current++;
    setReview(undefined);
    setError(undefined);
    setBusy(false);
    if (!backend || !threadId || !api?.listThreadReviews) return;
    let cancelled = false;
    let loading = false;
    let queued = false;
    const reload = async (): Promise<void> => {
      if (loading) {
        queued = true;
        return;
      }
      loading = true;
      try {
        do {
          queued = false;
          const reviews = await readReviews(api, { backend, threadId,
            ...(instanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
          });
          if (!cancelled) setReview(reviews.find((entry) => id ? entry.id === id : entry.sourceKey === sourceKey));
        } while (queued && !cancelled);
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      } finally {
        loading = false;
      }
    };
    void reload();
    const unsubscribe = api.onThreadTodosChanged?.((event) => {
      if (event.federationTarget?.instanceId !== instanceId && event.backend !== undefined) return;
      if (event.backend === undefined || (event.backend === backend && event.threadId === threadId)) void reload();
    });
    return () => {
      generation.current++;
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, backend, threadId, instanceId, id, sourceKey]);
  const update = useCallback<ReviewUpdate>(async (request) => {
    if (!review || !api?.updateThreadReview) return;
    const startedGeneration = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.updateThreadReview({ id: review.id, ...request,
        ...(instanceId ? { federationTarget: { scope: "remote", instanceId } } : {}),
      });
      if (generation.current === startedGeneration) setReview(response.review);
    } catch (error) {
      if (generation.current === startedGeneration) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === startedGeneration) setBusy(false);
    }
  }, [api, review, instanceId]);
  return { review, update, busy, error };
}

/**
 * What a settled finding reads, in the words the agent tools use: one table
 * for the transcript and the To-do card. A finding of a dismissed review
 * reads Dismissed, the review's own outcome.
 */
const SETTLED_FINDING_LABELS = {
  addressed: { label: "Addressed", Icon: CheckIcon },
  declined: { label: "Declined", Icon: BanIcon },
  deferred: { label: "Deferred", Icon: TodoIcon },
  dismissed: { label: "Dismissed", Icon: BanIcon },
} as const;

export type SettledFindingStatus = keyof typeof SETTLED_FINDING_LABELS;

/**
 * A settled finding's label. A status this build does not know, from a newer
 * peer, still reads as settled rather than failing the render.
 */
function settledFindingLabel(status: string) {
  return Object.hasOwn(SETTLED_FINDING_LABELS, status)
    ? SETTLED_FINDING_LABELS[status as SettledFindingStatus]
    : { label: "Settled", Icon: CheckIcon };
}

/** A settled finding's status as labelled, or undefined while it is open. */
export function settledFindingStatus(review: ThreadReview, item: ThreadReviewItem): string | undefined {
  if (review.status === "dismissed") return "dismissed";
  return item.status === "open" ? undefined : item.status;
}

/** A settled finding's glyph and label. */
export function SettledFindingLabel(props: { status: string; size: number }) {
  const { label, Icon } = settledFindingLabel(props.status);
  return <><Icon size={props.size} />{label}</>;
}

export { orderReviewItems } from "../../../../shared/review-fix-prompts";

export function openReviewItems(review: ThreadReview): ThreadReviewItem[] {
  return review.items.filter((item) => item.status === "open");
}

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * Names the evidence a resolution links to. A commit or pull request reads as
 * one; anything else as its host, with the whole URL in the tooltip.
 */
export function formatEvidenceLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const commit = /\/commit\/([0-9a-f]{7,40})\b/i.exec(parsed.pathname);
    if (commit) return `Commit ${commit[1]!.slice(0, 7)}`;
    const pull = /\/(?:pull|merge_requests)\/(\d+)\b/.exec(parsed.pathname);
    if (pull) return `PR #${pull[1]}`;
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}

/**
 * Who settled it, then the documented reason. An operator's own click carries
 * a stock note that only restates the outcome, so it is left out.
 */
function describeResolution(outcome: string, resolution: ThreadReviewResolution): string {
  switch (resolution.actor) {
    case "user":
      return `${outcome} by you`;
    case "agent":
      return `${outcome} by the agent · ${resolution.note}`;
    case "system":
      return resolution.note;
  }
}

function ResolutionDetails(props: { outcome: string; resolution: ThreadReviewResolution }) {
  const { resolution } = props;
  return (
    <>
      <span className="review-status__note">{describeResolution(props.outcome, resolution)}</span>
      {resolution.todo ? (
        <span className="review-status__todo" title={resolution.todo.title}>
          <TodoIcon size={12} />
          <span className="review-status__todo-title">{resolution.todo.title}</span>
        </span>
      ) : null}
      {resolution.url ? (
        <a
          className="review-status__link"
          href={resolution.url}
          target="_blank"
          rel="noopener noreferrer"
          title={resolution.url}
        >
          {formatEvidenceLabel(resolution.url)}
        </a>
      ) : null}
      <time className="review-status__time" dateTime={new Date(resolution.at).toISOString()}>
        {timeFormat.format(resolution.at)}
      </time>
    </>
  );
}

/** The whole review's standing, under the transcript card's verdict. */
export function ReviewStatusRow(props: { review: ThreadReview; busy: boolean; update: ReviewUpdate }) {
  const { review, busy, update } = props;
  const open = openReviewItems(review).length;
  const total = review.items.length;
  if (review.status === "open") {
    return (
      <div className="review-status" data-status="open">
        <span className="review-status__state" data-status="open">
          <span className="review-status__dot" aria-hidden="true" />
          {open > 0
            ? `${open} of ${total} ${total === 1 ? "finding" : "findings"} open`
            : "Waiting for resolution"}
        </span>
        <span className="review-status__note">
          {open > 0
            ? "Tracked in To-dos until each finding is addressed, declined, or deferred."
            : "No findings left open. Mark it handled once you are done with it."}
        </span>
        <div className="review-status__actions">
          <button
            type="button"
            className="button review-status__button review-status__button--quiet"
            disabled={busy}
            onClick={() => void update({ status: "dismissed" })}
          >
            Dismiss review
          </button>
          {open === 0 ? (
            <button
              type="button"
              className="button button--secondary review-status__button"
              disabled={busy}
              onClick={() => void update({ status: "handled" })}
            >
              <CheckIcon size={12} />
              Mark handled
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  const dismissed = review.status === "dismissed";
  // A handled review reopens through its findings; only one with none to
  // reopen, or a dismissed one, offers the whole review.
  const reopenable = dismissed || total === 0;
  return (
    <div className="review-status" data-status={review.status}>
      <span className="review-status__state" data-status={review.status}>
        {dismissed ? <BanIcon size={12} /> : <CheckIcon size={12} />}
        {dismissed ? "Dismissed" : "Handled"}
      </span>
      {review.resolution ? (
        <ResolutionDetails outcome={dismissed ? "Dismissed" : "Handled"} resolution={review.resolution} />
      ) : null}
      {reopenable ? (
        <div className="review-status__actions">
          <button
            type="button"
            className="button review-status__button review-status__button--quiet"
            disabled={busy}
            onClick={() => void update({ status: "open" })}
          >
            Reopen review
          </button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A running review that will auto-fix when it lands. Don't auto-fix turns
 * that off for this review only.
 */
export function ReviewAutoFixArmedRow(props: { busy: boolean; error?: string; onDisarm: () => void }) {
  return (
    <>
      <div className="review-status" data-status="armed">
        <span className="review-status__state" data-status="armed">
          <PendingSpinner pairing="paired" size="sm" />
          Auto-fix armed
        </span>
        <span className="review-status__note">
          This thread&apos;s agent settles the findings when the review ends.
        </span>
        <div className="review-status__actions">
          <button
            type="button"
            className="button review-status__button review-status__button--quiet"
            disabled={props.busy}
            onClick={props.onDisarm}
          >
            Don&apos;t auto-fix
          </button>
        </div>
      </div>
      {props.error ? <p className="review-status__error" role="alert">{props.error}</p> : null}
    </>
  );
}

/**
 * The review card's line for its Auto-fix turn: queued behind a running
 * turn, running, finished with findings still open, or refused before it
 * started. Nothing once a finished run left nothing open.
 */
export function ReviewAutoFixLine(props: { run: ReviewAutoFixRun | undefined; openCount: number }) {
  const { run } = props;
  if (!run) return null;
  if (run.phase === "running") {
    return (
      <p className="review-todo__auto" data-phase="running">
        <PendingSpinner pairing="paired" size="sm" />
        <span><strong>Auto-fixing</strong> · started when the review finished</span>
      </p>
    );
  }
  if (run.phase === "queued") {
    return (
      <p className="review-todo__auto" data-phase="queued">
        <ClockIcon size={12} />
        <span><strong>Auto-fix queued</strong> · sends when the current turn ends</span>
      </p>
    );
  }
  if (run.phase === "failed") {
    return (
      <p className="review-todo__auto" data-phase="failed">
        <BanIcon size={12} />
        <span><strong>Auto-fix could not start:</strong> {run.reason}</span>
      </p>
    );
  }
  if (props.openCount === 0) return null;
  return (
    <p className="review-todo__auto" data-phase="finished">
      <TodoIcon size={12} />
      <span><strong>Auto-fix left {props.openCount} open</strong></span>
    </p>
  );
}

/** A settled finding's label in its head; a whole-review dismissal labels every finding. */
export function ReviewFindingState(props: { review: ThreadReview; item: ThreadReviewItem }) {
  const status = settledFindingStatus(props.review, props.item);
  if (!status) return null;
  return (
    <span className="review-finding-state" data-status={status}>
      <SettledFindingLabel status={status} size={12} />
    </span>
  );
}

/**
 * The transcript's per-finding controls carry only state from the record.
 * `title` is the finding's title as the transcript renders it, so the
 * accessible names match the text on screen rather than the stored excerpt.
 */
type TranscriptFindingControlsProps = {
  review: ThreadReview;
  item: ThreadReviewItem;
  title: string;
  busy: boolean;
  update: ReviewUpdate;
};

/** The two ways to settle an open finding, beside its location. */
export function ReviewFindingActions(props: TranscriptFindingControlsProps) {
  const { review, item, title, busy, update } = props;
  if (review.status === "dismissed" || item.status !== "open") return null;
  return (
    <div className="review-status__actions">
      <button
        type="button"
        className="button review-status__button review-status__button--quiet"
        aria-label={`Decline finding: ${title}`}
        disabled={busy}
        onClick={() => void update({ itemId: item.id, status: "declined" })}
      >
        Decline
      </button>
      <button
        type="button"
        className="button button--secondary review-status__button"
        aria-label={`Mark addressed: ${title}`}
        disabled={busy}
        onClick={() => void update({ itemId: item.id, status: "addressed" })}
      >
        <CheckIcon size={12} />
        Mark addressed
      </button>
    </div>
  );
}

/** How a settled finding was settled: who, why, the evidence, and when. */
export function ReviewFindingResolution(props: TranscriptFindingControlsProps) {
  const { review, item, title, busy, update } = props;
  if (review.status === "dismissed" || item.status === "open" || !item.resolution) return null;
  return (
    <div className="review-status" data-status={item.status}>
      <ResolutionDetails
        outcome={settledFindingLabel(item.status).label}
        resolution={item.resolution}
      />
      <div className="review-status__actions">
        <button
          type="button"
          className="button review-status__button review-status__button--quiet"
          aria-label={`Reopen finding: ${title}`}
          disabled={busy}
          onClick={() => void update({ itemId: item.id, status: "open" })}
        >
          Reopen
        </button>
      </div>
    </div>
  );
}
