import { useEffect, useState } from "react";
import type { AgentEvent, NavigationSelectedDetailRequest, PrSummary } from "@pwragent/shared";
import { buildPullRequestStatusKey } from "@pwragent/shared";
import { getDesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";
import { readRendererFederationTarget } from "./federation-window";
import type { NavigationPresentedThread } from "./navigation-loaded-rows";

export type PullRequestAttachmentThread = Pick<NavigationPresentedThread,
  "id" | "source" | "federation" | "prs" | "prsTruncated" | "prCount"
>;

type AttachmentNotification = Extract<AgentEvent["notification"], {
  method: "thread/pullRequests/updated" | "pullRequest/status/updated";
}>;

let nextConsumer = 0;

/** Read the complete owner attachment list only while its disclosure is open. */
export function useThreadPullRequestAttachments(thread: PullRequestAttachmentThread | undefined) {
  const target = thread?.federation?.ref.target ?? readRendererFederationTarget();
  const owner = target?.scope === "remote" ? target.instanceId : undefined;
  const backend = thread?.source;
  const threadId = thread?.id;
  const preview = thread?.prs;
  // A row from an older owner lacks the count. Its exact configuration
  // already carries every attachment, before collection paging was added.
  const paged = thread?.prCount !== undefined;
  const key = thread?.prsTruncated ? JSON.stringify([owner, backend, threadId, thread.prCount]) : undefined;
  const [result, setResult] = useState<{ key: string; preview?: PrSummary[]; prs?: PrSummary[] }>();

  useEffect(() => {
    if (!key || !backend || !threadId) {
      setResult(undefined);
      return;
    }
    const api = getDesktopApi();
    const consumer = `pr-attachments:${++nextConsumer}`;
    let cancelled = false;
    let currentPrs: PrSummary[] | undefined;
    const request: NavigationSelectedDetailRequest = {
      protocol: 2,
      ref: { backend, threadId, ownerInstanceId: owner },
      federationTarget: owner ? { scope: "remote", instanceId: owner } : undefined,
    };
    const read = async (): Promise<PrSummary[]> => {
      if (!api?.getNavigationSelectedDetail) throw new Error("Missing selected detail reader.");
      if (!paged) {
        const detail = await api.getNavigationSelectedDetail(request, consumer);
        if (!detail.thread) throw new Error("Missing thread configuration.");
        return detail.thread.prs ?? [];
      }
      const prs: PrSummary[] = [];
      const cursors = new Set<string>();
      const encoder = new TextEncoder();
      let bytes = 0;
      let cursor: string | undefined;
      let revision: string | undefined;
      do {
        const { collectionPage: page } = await api.getNavigationSelectedDetail({
          ...request, collection: { name: "prs", cursor },
        }, consumer);
        if (cancelled) return [];
        if (page?.name !== "prs" || !page.values.prs
          || (revision !== undefined && page.revision !== revision)
          || page.complete === Boolean(page.nextCursor)
          || (page.nextCursor && cursors.has(page.nextCursor))) {
          throw new Error("Pull request attachments changed while loading.");
        }
        bytes += encoder.encode(JSON.stringify(page.values.prs)).byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error("Pull request attachments exceed the retained budget.");
        prs.push(...page.values.prs);
        ({ revision, nextCursor: cursor } = page);
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return prs;
    };
    const publish = (prs?: PrSummary[]) => {
      if (cancelled) return;
      currentPrs = prs;
      setResult({ key, preview, prs });
    };
    const unsubscribe = api?.onAgentEvent?.((event) => {
      if (!federationTargetsEqual(event.federationTarget, request.federationTarget)) return;
      const notification = event.notification as AttachmentNotification;
      if (notification.method === "thread/pullRequests/updated"
        && event.backend === backend && notification.params.threadId === threadId) {
        publish(notification.params.prs);
      } else if (notification.method === "pullRequest/status/updated" && currentPrs) {
        const { prKey, pr } = notification.params;
        const index = currentPrs.findIndex((attachment) => buildPullRequestStatusKey(attachment) === prKey);
        if (index < 0) return;
        const updated = { ...pr, explicitlyAttached: currentPrs[index]!.explicitlyAttached };
        publish(currentPrs.with(index, updated));
      }
    });
    const release = () => { void api?.releaseNavigationQuery?.(consumer).catch(() => undefined); };
    void read().then(
      (prs) => { if (!currentPrs) publish(prs); },
      () => { if (!currentPrs) publish(); },
    ).finally(release);
    return () => {
      cancelled = true;
      unsubscribe?.();
      release();
    };
  }, [backend, key, owner, paged, preview, threadId]);

  if (!key) return { prs: preview };
  if (result?.key !== key || result.preview !== preview) return { loading: true };
  return result.prs ? { prs: result.prs } : { failed: true };
}
