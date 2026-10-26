import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ThreadReview,
  ThreadReviewIdentity,
  ThreadReviewItem,
  ThreadReviewResolution,
  UpdateThreadReviewRequest,
} from "@pwragent/shared";
import { BanIcon, CheckIcon, TodoIcon } from "../../icons";
import { useDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";
import { reviewFindingTag } from "../../../../shared/review-output";

const pendingReads = new WeakMap<DesktopApi, Map<string, Promise<ThreadReview[]>>>();

/** The transcript and its To-do card share one read when the same event arrives. */
function readReviews(api: DesktopApi, identity: ThreadReviewIdentity): Promise<ThreadReview[]> {
  let pending = pendingReads.get(api);
  if (!pending) {
    pending = new Map();
    pendingReads.set(api, pending);
  }
  const key = JSON.stringify([identity.federationTarget?.instanceId, identity.backend, identity.threadId]);
  const current = pending.get(key);
  if (current) return current;
  const request = api.listThreadReviews!({ ...identity, status: "all" })
    .then((response) => response.reviews)
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
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

/** A settled finding's status as labelled, or undefined while it is open. */
export function settledFindingStatus(review: ThreadReview, item: ThreadReviewItem): SettledFindingStatus | undefined {
  if (review.status === "dismissed") return "dismissed";
  return item.status === "open" ? undefined : item.status;
}

/** A settled finding's glyph and label. */
export function SettledFindingLabel(props: { status: SettledFindingStatus; size: number }) {
  const { label, Icon } = SETTLED_FINDING_LABELS[props.status];
  return <><Icon size={props.size} />{label}</>;
}

/** Open findings first, then by priority; ties keep the reviewer's order. */
export function orderReviewItems(items: readonly ThreadReviewItem[]): ThreadReviewItem[] {
  const rank = (item: ThreadReviewItem): number => item.priority ?? 9;
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) =>
      Number(a.item.status !== "open") - Number(b.item.status !== "open")
      || rank(a.item) - rank(b.item)
      || a.index - b.index)
    .map(({ item }) => item);
}

export function openReviewItems(review: ThreadReview): ThreadReviewItem[] {
  return review.items.filter((item) => item.status === "open");
}

/**
 * The reply the review card's Fix button sends to the review's own thread:
 * the findings the operator picked, by title. `list_reviews` returns their
 * details and ids, and with them how to settle each one.
 */
export function fixReviewFindingsPrompt(reviewTitle: string, items: readonly ThreadReviewItem[]): string {
  const findings = items.map((item, index) => {
    const tag = reviewFindingTag(item);
    return `${index + 1}. ${tag ? `[${tag}] ` : ""}${item.title}`;
  });
  return [
    items.length === 1
      ? `Fix this finding from ${reviewTitle}:`
      : `Fix these ${items.length} findings from ${reviewTitle}:`,
    "",
    ...findings,
    "",
    "Use PwrAgent's `list_reviews` tool for their details and how to record each fix.",
  ].join("\n");
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
        outcome={SETTLED_FINDING_LABELS[item.status].label}
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
