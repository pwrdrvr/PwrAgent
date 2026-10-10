import { useCallback, useEffect, useRef, useState } from "react";
import type { ThreadReview, ThreadReviewIdentity, ThreadReviewItem, UpdateThreadReviewRequest } from "@pwragent/shared";
import { useDesktopApi, type DesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

const pendingReads = new WeakMap<DesktopApi, Map<string, Promise<ThreadReview[]>>>();

/** The transcript and its To-do card share one read when the same event arrives. */
function readReviews(api: DesktopApi, identity: ThreadReviewIdentity): Promise<ThreadReview[]> {
  let pending = pendingReads.get(api);
  if (!pending) {
    pending = new Map();
    pendingReads.set(api, pending);
  }
  const key = JSON.stringify([identity.backend, identity.threadId]);
  const current = pending.get(key);
  if (current) return current;
  const request = api.listThreadReviews!({ ...identity, status: "all" })
    .then((response) => response.reviews)
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function useTrackedReview(
  identity: ThreadReviewIdentity | undefined,
  target: { id?: string; sourceKey?: string },
) {
  const desktopApi = useDesktopApi();
  const api = readRendererFederationTarget() ? undefined : desktopApi;
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
          const reviews = await readReviews(api, { backend, threadId });
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
      if (event.backend === backend && event.threadId === threadId) void reload();
    });
    return () => {
      generation.current++;
      cancelled = true;
      unsubscribe?.();
    };
  }, [api, backend, threadId, id, sourceKey]);
  const update = useCallback(async (request: Omit<UpdateThreadReviewRequest, "id">): Promise<void> => {
    if (!review || !api?.updateThreadReview) return;
    const startedGeneration = generation.current;
    setBusy(true);
    setError(undefined);
    try {
      const response = await api.updateThreadReview({ id: review.id, ...request });
      if (generation.current === startedGeneration) setReview(response.review);
    } catch (error) {
      if (generation.current === startedGeneration) setError(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation.current === startedGeneration) setBusy(false);
    }
  }, [api, review]);
  return { review, update, busy, error };
}

export function ReviewStatusControls(props: {
  review: ThreadReview;
  item?: ThreadReviewItem;
  busy: boolean;
  update: (request: Omit<UpdateThreadReviewRequest, "id">) => Promise<void>;
}) {
  const target = props.item ?? props.review;
  const dismissed = target.status === "dismissed" || props.review.status === "dismissed";
  const label = dismissed ? "Do not address" : target.status === "open" ? "Waiting for resolution" : "Addressed";
  const change = (status: UpdateThreadReviewRequest["status"]): void => {
    void props.update({ status, ...(props.item ? { itemId: props.item.id } : {}) });
  };
  return (
    <div className="review-tracking" data-status={dismissed ? "dismissed" : target.status}>
      <span>{label}</span>
      {target.resolution ? <span title={new Date(target.updatedAt).toLocaleString()}>{target.resolution.note}</span> : null}
      {target.resolution?.url ? <a href={target.resolution.url} target="_blank" rel="noopener noreferrer">Resolution</a> : null}
      {target.status !== "open" ? (
        <button type="button" disabled={props.busy} aria-label={props.item ? `Reopen finding: ${props.item.title}` : "Reopen review"} onClick={() => change("open")}>Reopen</button>
      ) : props.review.status === "open" ? (
        <>
          {props.item || props.review.items.length === 0 ? (
            <button type="button" disabled={props.busy} aria-label={props.item ? `Mark addressed: ${props.item.title}` : "Mark review addressed"} onClick={() => change(props.item ? "addressed" : "handled")}>Mark addressed</button>
          ) : null}
          <button type="button" disabled={props.busy} aria-label={props.item ? `Dismiss finding: ${props.item.title}` : "Dismiss review"} onClick={() => change("dismissed")}>
            {props.item ? "Dismiss finding" : "Dismiss review"}
          </button>
        </>
      ) : null}
    </div>
  );
}
