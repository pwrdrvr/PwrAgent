import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { buildPullRequestStatusKey, type AgentEvent, type NavigationSelectedDetailRequest, type NavigationSelectedDetailResponse, type PrSummary } from "@pwragent/shared";
import type { DesktopApi } from "../desktop-api";
import { useThreadPullRequestAttachments, type PullRequestAttachmentThread } from "../useThreadPullRequestAttachments";

const pr: PrSummary = {
  provider: "github.com", org: "fixture", repo: "repo", number: 21,
  url: "https://github.com/fixture/repo/pull/21", state: "passing", explicitlyAttached: true,
};
const remote = { scope: "remote", instanceId: "peer" } as const;
const peerThread: PullRequestAttachmentThread = {
  id: "thread", source: "codex", prs: [], prsTruncated: true, prCount: 21,
  federation: {
    instanceLabel: "peer", ref: { backend: "codex", threadId: "thread", target: remote },
  },
};

function page(request: NavigationSelectedDetailRequest, prs: PrSummary[], options: { revision?: string; cursor?: string } = {}): NavigationSelectedDetailResponse {
  const revision = options.revision ?? "attachments";
  return {
    protocol: 2, ref: request.ref, revision, readiness: "ready", identity: "present",
    collectionPage: { name: "prs", values: { prs }, complete: !options.cursor, nextCursor: options.cursor, revision },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("applies authorized status before or after the baseline without changing attachment membership", async () => {
  await fc.assert(fc.asyncProperty(
    fc.boolean(), fc.boolean(), fc.constantFrom("local", "owner", "other"),
    async (duringRead, peerWindow, source) => {
      const status: PrSummary = { ...pr, state: "merged", explicitlyAttached: undefined };
      const origin = source === "local" ? undefined : source === "owner" ? remote
        : { scope: "remote", instanceId: "other" } as const;
      const seen = Promise.withResolvers<NavigationSelectedDetailResponse>();
      const getNavigationSelectedDetail = vi.fn((_request: NavigationSelectedDetailRequest) => seen.promise);
      const onAgentEvent = vi.fn<NonNullable<DesktopApi["onAgentEvent"]>>();
      vi.stubGlobal("pwragent", { getNavigationSelectedDetail, onAgentEvent });
      vi.stubGlobal("__pwragentFederationTarget", peerWindow ? remote : undefined);
      const { result, unmount } = renderHook(() => useThreadPullRequestAttachments(peerThread));
      try {
        const send = (notification: AgentEvent["notification"], federationTarget?: AgentEvent["federationTarget"]) =>
          act(() => onAgentEvent.mock.lastCall?.[0]({ backend: "codex", federationTarget, notification }));
        const update = () => send({ method: "pullRequest/status/updated",
          params: { prKey: buildPullRequestStatusKey(pr), pr: status } }, origin);
        if (duringRead) update();
        await act(async () => seen.resolve(page(getNavigationSelectedDetail.mock.lastCall![0], [pr])));
        if (!duringRead) update();
        // The local instance can supply status in its own main window. A
        // different owner cannot replace the peer thread's attachment list.
        send({ method: "thread/pullRequests/updated", params: { threadId: "thread", prs: [] } });
        const expected = source === "owner" || (source === "local" && !peerWindow)
          ? { ...status, explicitlyAttached: true } : pr;
        expect(result.current.prs).toEqual([expected]);
      } finally {
        unmount();
      }
    },
  ), { numRuns: 24 });
});

it.each([false, true])("restarts a cursor at most once and requires a complete list (second expiry: %s)", async (expiresAgain) => {
  const getNavigationSelectedDetail = vi.fn(async (request: NavigationSelectedDetailRequest) => page(request, [pr]));
  const obsolete = { ...pr, state: "closed" } satisfies PrSummary;
  const expiry = new Error("[navigation_cursor_expired] Selected collection changed while paging.");
  const restarted = Promise.withResolvers<NavigationSelectedDetailResponse>();
  getNavigationSelectedDetail
    .mockImplementationOnce(async (request) => page(request, [obsolete], { cursor: "stale" }))
    .mockRejectedValueOnce(expiry)
    .mockImplementationOnce(() => restarted.promise);
  if (expiresAgain) getNavigationSelectedDetail.mockRejectedValueOnce(expiry);
  vi.stubGlobal("pwragent", { getNavigationSelectedDetail });
  const { result } = renderHook(() => useThreadPullRequestAttachments(peerThread));
  await waitFor(() => expect(getNavigationSelectedDetail).toHaveBeenCalledTimes(3));
  expect(result.current.loading).toBe(true);
  expect(result.current.prs).toBeUndefined();
  const request = getNavigationSelectedDetail.mock.lastCall![0];
  await act(async () => restarted.resolve(page(request, [pr], { cursor: expiresAgain ? "again" : undefined })));
  expect(result.current).toEqual(expiresAgain ? { failed: true } : { prs: [pr] });
  expect(getNavigationSelectedDetail.mock.calls.map(([request]) => request.collection?.cursor))
    .toEqual(expiresAgain ? [undefined, "stale", undefined, "again"] : [undefined, "stale", undefined]);
});
