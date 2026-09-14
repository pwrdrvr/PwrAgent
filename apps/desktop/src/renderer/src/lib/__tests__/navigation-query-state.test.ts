import { describe, expect, it } from "vitest";
import type { NavigationQueryPage, NavigationQueryRequest, NavigationSelectedDetailResponse } from "@pwragent/shared";
import {
  applyNavigationPage,
  applyNavigationSelectedDetail,
  beginNavigationPageRead,
  createNavigationPageState,
  failNavigationPageRead,
  navigationIdentityKey,
  navigationIdentityFromThreadKey,
  navigationSelectionAuthorizesComposer,
  selectNavigationIdentity,
} from "../navigation-query-state";
import type { NavigationSelectionState } from "../navigation-query-state";

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

it("retains only the acknowledged partial range and adopts its renewed generation", () => {
  const directory = { key: "directory", label: "Directory", counts: { total: 30, active: 0, unread: 0, review: 0 } };
  let state = beginNavigationPageRead(createNavigationPageState(request));
  state = applyNavigationPage({ state, sequence: state.pendingSequence,
    page: page({ directories: [directory] as NavigationQueryPage["directories"] }) });
  state = beginNavigationPageRead(state);
  const acknowledgment = page({ generation: "renewed", nextCursor: "renewed-next",
    rangeUnchanged: { start: 0, count: 1 }, directories: [] });
  const applied = applyNavigationPage({ state, sequence: state.pendingSequence, page: acknowledgment });
  expect(applied.page?.directories).toBe(state.page?.directories);
  expect(applied.page?.generation).toBe("renewed");
  expect(applied.page?.nextCursor).toBe("renewed-next");
  expect(applied.page?.complete).toBe(false);
  for (const patch of [{ countsRevision: "changed" }, { ownerEpoch: "restarted" }, { rangeUnchanged: { start: 0, count: 2 } }]) {
    expect(() => applyNavigationPage({ state, sequence: state.pendingSequence,
      page: { ...acknowledgment, ...patch } })).toThrow("matching retained range");
  }
});


it("retains disconnected child state through retries until a successful page arrives", () => {
  const previous = firstPage();
  const failed = failNavigationPageRead(previous, previous.pendingSequence,
    new Error("Error invoking remote method: Federation peer pwr_fixture is not connected."));
  const retry = beginNavigationPageRead(failed);
  expect(retry.error).toBe(failed.error);
  expect(retry.page).toBe(previous.page);
  const recovered = applyNavigationPage({ state: retry, sequence: retry.pendingSequence, page: page() });
  expect(recovered.error).toBeUndefined();
  expect(recovered.stale).toBe(false);
  const other = failNavigationPageRead(previous, previous.pendingSequence, new Error("Invalid query"));
  expect(other.error).toBe("Invalid query");
  expect(beginNavigationPageRead(other).error).toBeUndefined();
});

describe("composer authorization outlives revalidation", () => {
  const selected = { backend: "codex" as const, threadId: "selected" };
  function detailResponse(
    patch: Partial<NavigationSelectedDetailResponse> = {},
  ): NavigationSelectedDetailResponse {
    return {
      protocol: 2, ref: selected, revision: "r1", readiness: "ready", identity: "present",
      thread: {
        source: "codex", id: selected.threadId, title: "Selected", titleSource: "explicit",
        linkedDirectories: [], inbox: { inInbox: true }, threadStatus: "idle",
      },
      ...patch,
    };
  }
  function authorized(): NavigationSelectionState {
    const started = selectNavigationIdentity(undefined, selected);
    return applyNavigationSelectedDetail({
      state: started, sequence: started.pendingSequence, detail: detailResponse(),
    });
  }

  it("keeps the composer through a same-identity refresh and withdraws it exactly", () => {
    const ready = authorized();
    expect(ready.readiness).toBe("ready");
    expect(navigationSelectionAuthorizesComposer(ready)).toBe(true);

    // What `useNavigationSelectedDetail` publishes the moment an admitted event
    // fences the current read: `loading`, marked stale, detail retained. The
    // authorization is the completed read, so it must survive this.
    const revalidating: NavigationSelectionState = {
      ...selectNavigationIdentity(ready, selected), stale: true,
    };
    expect(revalidating.readiness).toBe("loading");
    expect(revalidating.detail).toBe(ready.detail);
    expect(navigationSelectionAuthorizesComposer(revalidating)).toBe(true);

    // A read that completed and failed does withdraw it, detail and all.
    expect(navigationSelectionAuthorizesComposer({
      ...revalidating, readiness: "failed", error: "Owner unreachable",
    })).toBe(false);

    // So does a thread that stopped being present.
    const archived = selectNavigationIdentity(ready, selected);
    expect(navigationSelectionAuthorizesComposer(applyNavigationSelectedDetail({
      state: archived, sequence: archived.pendingSequence,
      detail: detailResponse({ revision: "r2", identity: "archived", thread: undefined }),
    }))).toBe(false);
  });

  it("never authorizes before this identity's own exact read lands", () => {
    expect(navigationSelectionAuthorizesComposer(undefined)).toBe(false);
    expect(navigationSelectionAuthorizesComposer(selectNavigationIdentity(undefined, selected))).toBe(false);
    // Selecting a different thread drops the previous detail rather than
    // letting it authorize the newly selected thread's composer.
    const moved = selectNavigationIdentity(authorized(), { backend: "codex", threadId: "other" });
    expect(moved.detail).toBeUndefined();
    expect(navigationSelectionAuthorizesComposer(moved)).toBe(false);
  });
});
