import { useCallback, useEffect, useState } from "react";
import type { ThreadReview, ThreadReviewIdentity, ThreadReviewItem, UpdateThreadReviewRequest } from "@pwragent/shared";
import { useDesktopApi } from "../../lib/desktop-api";
import { readRendererFederationTarget } from "../../lib/federation-window";

export function useTrackedReview(
  identity: ThreadReviewIdentity | undefined,
  target: { id?: string; sourceKey?: string },
) {
  const desktopApi = useDesktopApi();
  const api = readRendererFederationTarget() ? undefined : desktopApi;
  const [review, setReview] = useState<ThreadReview>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const backend = identity?.backend;
  const threadId = identity?.threadId;
  const { id, sourceKey } = target;
  useEffect(() => {
    setReview(undefined);
    if (!backend || !threadId || !api?.listThreadReviews) return;
    let cancelled = false;
    const reload = async (): Promise<void> => {
      try {
        const response = await api.listThreadReviews!({ backend, threadId, status: "all" });
        if (!cancelled) setReview(response.reviews.find((entry) => id ? entry.id === id : entry.sourceKey === sourceKey));
      } catch (error) {
        if (!cancelled) setError(error instanceof Error ? error.message : String(error));
      }
    };
    void reload();
    const unsubscribe = api.onThreadTodosChanged?.((event) => {
      if (event.backend === backend && event.threadId === threadId) void reload();
    });
    return () => { cancelled = true; unsubscribe?.(); };
  }, [api, backend, threadId, id, sourceKey]);
  const update = useCallback(async (request: Omit<UpdateThreadReviewRequest, "id">): Promise<void> => {
    if (!review || !api?.updateThreadReview) return;
    setBusy(true);
    setError(undefined);
    try {
      setReview((await api.updateThreadReview({ id: review.id, ...request })).review);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
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
        <button type="button" disabled={props.busy} onClick={() => change("open")}>Reopen</button>
      ) : props.review.status === "open" ? (
        <>
          {props.item || props.review.items.length === 0 ? (
            <button type="button" disabled={props.busy} onClick={() => change(props.item ? "addressed" : "handled")}>Mark addressed</button>
          ) : null}
          <button type="button" disabled={props.busy} onClick={() => change("dismissed")}>
            {props.item ? "Dismiss finding" : "Dismiss review"}
          </button>
        </>
      ) : null}
    </div>
  );
}
