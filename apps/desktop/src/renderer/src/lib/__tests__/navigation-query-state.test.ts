import { describe, expect, it } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest } from "@pwragent/shared";
import {
  applyNavigationPage,
  applyNavigationSelectedDetail,
  beginNavigationPageRead,
  createNavigationPageState,
  failNavigationPageRead,
  navigationIdentityKey,
  navigationIdentityFromThreadKey,
  selectNavigationIdentity,
} from "../navigation-query-state";

const request: NavigationQueryRequest = {
  protocol: 2, consumer: "main-sidebar", query: { kind: "lens", lens: "inbox" },
};
function page(patch: Partial<NavigationQueryPage> = {}): NavigationQueryPage {
  return {
    protocol: 2, queryKey: "inbox", generation: "generation", ownerEpoch: "epoch",
    countsRevision: "revision", counts: { total: 1000, active: 40, unread: 60, review: 20 },
    coverage: { state: "complete" }, entries: [], complete: false, nextCursor: "next",
    ...patch,
  };
}
function firstPage() {
  const state = beginNavigationPageRead(createNavigationPageState(request));
  return applyNavigationPage({ state, sequence: state.pendingSequence, page: page() });
}

describe("distinct navigation page state", () => {
  it("retains authoritative off-page counts without claiming the range is complete", () => {
    const state = firstPage();
    expect(state.page?.counts.total).toBe(1000);
    expect(state.page?.entries).toEqual([]);
    expect(state.page?.complete).toBe(false);
  });

  it("rejects mixed generations and mismatched cursors without mutating the old page", () => {
    const state = beginNavigationPageRead(firstPage());
    for (const patch of [{ generation: "other" }, { ownerEpoch: "restart" }, { countsRevision: "new" }]) {
      expect(() => applyNavigationPage({
        state, sequence: state.pendingSequence, cursor: "next",
        page: page({ ...patch, complete: true, nextCursor: undefined }),
      })).toThrow("loaded generation");
    }
    expect(state.page?.nextCursor).toBe("next");
    expect(() => applyNavigationPage({ state, sequence: state.pendingSequence, cursor: "older", page: page() }))
      .toThrow("loaded generation");
  });

  it("does not accept unchanged against a cold or partial baseline", () => {
    for (const state of [beginNavigationPageRead(createNavigationPageState(request)), firstPage()]) {
      expect(() => applyNavigationPage({
        state, sequence: state.pendingSequence, page: page({ unchanged: true, complete: true, nextCursor: undefined }),
      })).toThrow("complete matching baseline");
    }
  });

  it("ignores late page success and failure after a newer read", () => {
    const state = beginNavigationPageRead(firstPage());
    expect(applyNavigationPage({ state, sequence: 1, page: page({ generation: "old" }) })).toBe(state);
    expect(failNavigationPageRead(state, 1, new Error("old"))).toBe(state);
    const failed = failNavigationPageRead(state, state.pendingSequence, new Error("disconnected"));
    expect(failed.page).toBe(state.page);
    expect(failed.stale).toBe(true);
  });

  it("keeps exact selection independent of row omission and rejects foreign identity authority", () => {
    const ref = { backend: "codex" as const, threadId: "off-page", ownerInstanceId: "peer" };
    const selection = selectNavigationIdentity(undefined, ref);
    firstPage();
    expect(selection.ref).toBe(ref);
    expect(() => applyNavigationSelectedDetail({
      state: selection, sequence: selection.pendingSequence,
      detail: { protocol: 2, ref: { ...ref, ownerInstanceId: "foreign" }, revision: "detail", identity: "deleted", readiness: "ready" },
    })).toThrow("requested owner");
    const next = selectNavigationIdentity(selection, { ...ref, threadId: "next" });
    expect(applyNavigationSelectedDetail({
      state: next, sequence: selection.pendingSequence,
      detail: { protocol: 2, ref, revision: "detail", identity: "deleted", readiness: "ready" },
    })).toBe(next);
  });

  it("preserves exact owner routing when a native detail omits viewer presentation metadata", () => {
    const ref = { backend: "codex" as const, threadId: "same", ownerInstanceId: "peer" };
    const state = selectNavigationIdentity(undefined, ref);
    const detail = { protocol: 2 as const, ref, revision: "detail", readiness: "ready" as const, identity: "present" as const,
      thread: { id: "same", source: "codex" as const, title: "Thread", titleSource: "explicit" as const,
        linkedDirectories: [], inbox: { inInbox: false } } };
    const accepted = applyNavigationSelectedDetail({ state, sequence: state.pendingSequence, detail });
    expect(accepted.detail?.thread?.federation?.ref).toEqual({ backend: "codex", threadId: "same", target: { scope: "remote", instanceId: "peer" } });
    expect(() => applyNavigationSelectedDetail({ state, sequence: state.pendingSequence,
      detail: { ...detail, thread: { ...detail.thread, federation: { instanceLabel: "Other", ref: { backend: "codex", threadId: "same",
        target: { scope: "remote", instanceId: "foreign" } } } } } })).toThrow("another owner");
  });

  it("distinguishes owners even when backend and thread id collide", () => {
    const ref = { backend: "codex" as const, threadId: "same" };
    expect(navigationIdentityKey(ref)).not.toBe(navigationIdentityKey({ ...ref, ownerInstanceId: "peer" }));
  });
});


describe("durable selection identity", () => {
  it("resolves unloaded ACP identities and explicit owners without row membership", () => {
    expect(navigationIdentityFromThreadKey("remote:peer:acp:grok:id:with:colons")).toEqual({
      ownerInstanceId: "peer", backend: "acp:grok", threadId: "id:with:colons",
    });
    expect(navigationIdentityFromThreadKey("codex:thread", { scope: "remote", instanceId: "native-owner" })).toEqual({
      ownerInstanceId: "native-owner", backend: "codex", threadId: "thread",
    });
    expect(navigationIdentityFromThreadKey("local:codex:thread", { scope: "remote", instanceId: "other" })).toEqual({
      backend: "codex", threadId: "thread",
    });
    expect(navigationIdentityFromThreadKey("remote::codex:thread")).toBeUndefined();
    expect(navigationIdentityFromThreadKey("codex:")).toBeUndefined();
  });
});
