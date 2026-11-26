import { useEffect, useState } from "react";
import type { AgentEvent } from "@pwragent/shared/contracts/agent";
import type { NavigationSelectedDetailRequest, PrSummary } from "@pwragent/shared/contracts/navigation";
import { buildPullRequestStatusKey } from "@pwragent/shared/contracts/navigation";
import { getDesktopApi } from "./desktop-api";
import { federationTargetsEqual } from "./federated-thread-events";
import { readRendererFederationTarget } from "./federation-window";
import type { NavigationPresentedThread } from "./navigation-loaded-rows";
import { isNavigationCursorExpired } from "./navigation-query-state";

export type PullRequestAttachmentThread = Pick<NavigationPresentedThread,
  "id" | "source" | "federation" | "prs" | "prsTruncated" | "prCount"
>;

type AttachmentNotification = Extract<AgentEvent["notification"], {
  method: "thread/pullRequests/updated" | "pullRequest/status/updated";
}>;

let nextConsumer = 0;

/** Read the complete owner attachment list only while its disclosure is open. */
export function useThreadPullRequestAttachments(thread: PullRequestAttachmentThread | undefined) {
  const windowTarget = readRendererFederationTarget();
  const target = thread?.federation?.ref.target ?? windowTarget;
  const allowLocalStatus = !windowTarget;
  const owner = target?.scope === "remote" ? target.instanceId : undefined;
  const backend = thread?.source;
  const threadId = thread?.id;
  const preview = thread?.prs;
  // A row from an older owner lacks the count. Its exact configuration
  // already carries every attachment, before collection paging was added.
  const paged = thread?.prCount !== undefined;
  const key = thread?.prsTruncated ? JSON.stringify([owner, backend, threadId, thread.prCount]) : undefined;
  const [result, setResult] = useState<{ key: string; prs?: PrSummary[] }>();

  useEffect(() => {
    if (!key || !backend || !threadId) {
      setResult(undefined);
      return;
    }
    const api = getDesktopApi();
    const consumer = `pr-attachments:${++nextConsumer}`;
    let cancelled = false;
    let currentPrs: PrSummary[] | undefined;
    let baselinePending = true;
    const pendingStatuses = new Map<string, PrSummary>();
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
          || page.complete !== !page.nextCursor
          || (page.nextCursor && cursors.has(page.nextCursor))) {
          throw new Error("Invalid pull request attachments page.");
        }
        if (revision !== undefined && page.revision !== revision) {
          throw new Error("[navigation_cursor_expired] Pull request attachments changed while loading.");
        }
        bytes += encoder.encode(JSON.stringify(page.values.prs)).byteLength;
        if (bytes > 8 * 1024 * 1024) throw new Error("Pull request attachments exceed the retained budget.");
        prs.push(...page.values.prs);
        ({ revision, nextCursor: cursor } = page);
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return prs;
    };
    const readWithRestart = async (): Promise<PrSummary[]> => {
      try {
        return await read();
      } catch (error) {
        if (!paged || cancelled || !baselinePending || !isNavigationCursorExpired(error)) throw error;
        return await read();
      }
    };
    const publish = (prs?: PrSummary[]) => {
      if (cancelled) return;
      currentPrs = prs;
      setResult({ key, prs });
    };
    const publishBaseline = (prs?: PrSummary[]) => {
      baselinePending = false;
      if (prs && pendingStatuses.size > 0) {
        prs = prs.map((attachment) => {
          const status = pendingStatuses.get(buildPullRequestStatusKey(attachment));
          return status
            ? { ...status, explicitlyAttached: attachment.explicitlyAttached, autoFixOff: attachment.autoFixOff }
            : attachment;
        });
      }
      pendingStatuses.clear();
      publish(prs);
    };
    const unsubscribe = api?.onAgentEvent?.((event) => {
      const matchesOwner = federationTargetsEqual(event.federationTarget, request.federationTarget);
      const notification = event.notification as AttachmentNotification;
      if (notification.method === "thread/pullRequests/updated"
        && matchesOwner && event.backend === backend && notification.params.threadId === threadId) {
        publishBaseline(notification.params.prs);
      } else if (notification.method === "pullRequest/status/updated"
        && (matchesOwner || (allowLocalStatus && event.federationTarget?.scope !== "remote"))) {
        // Main already suppresses peer observations when it monitors this PR.
        // Its local observation still applies to a pinned peer's attachment.
        const { prKey, pr } = notification.params;
        if (baselinePending) pendingStatuses.set(prKey, pr);
        if (!currentPrs) return;
        const index = currentPrs.findIndex((attachment) => buildPullRequestStatusKey(attachment) === prKey);
        if (index < 0) return;
        const { explicitlyAttached, autoFixOff } = currentPrs[index]!;
        const updated = { ...pr, explicitlyAttached, autoFixOff };
        publish(currentPrs.with(index, updated));
      }
    });
    const release = () => { void api?.releaseNavigationQuery?.(consumer).catch(() => undefined); };
    void readWithRestart().then(
      (prs) => { if (baselinePending) publishBaseline(prs); },
      () => { if (baselinePending) publishBaseline(); },
    ).finally(release);
    return () => {
      cancelled = true;
      unsubscribe?.();
      release();
    };
  }, [allowLocalStatus, backend, key, owner, paged, threadId]);

  if (!key) return { prs: preview };
  if (result?.key !== key) return { loading: true };
  return result.prs ? { prs: result.prs } : { failed: true };
}
