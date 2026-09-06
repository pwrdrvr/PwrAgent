import { buildOwnedComposerScopeKey } from "@pwragent/shared";
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ComposerThreadOwner } from "@pwragent/shared";
import { useComposerDraftStore } from "../useComposerDraftStore";
import { resolveComposerScopeOwner, useOwnedComposerDraftStore } from "../useOwnedComposerDraftStore";
import { snapshotFromDraftRecord } from "../useDurableComposerDraftStore";

const owner: ComposerThreadOwner = {
  backend: "codex", threadId: "off-page", target: { scope: "remote", instanceId: "remote-owner" },
};
const draft = { draft: "Unsent text", skillTokens: [], imageAttachments: [] };

describe("composer scope ownership", () => {
  it("retains explicit owner metadata without changing store identity", () => {
    const scope = buildOwnedComposerScopeKey(owner);
    const { result, rerender } = renderHook(({ selectedOwner }) => {
      const base = useComposerDraftStore();
      const owned = useOwnedComposerDraftStore(base, buildOwnedComposerScopeKey(selectedOwner), selectedOwner);
      return { base, owned };
    }, { initialProps: { selectedOwner: owner } });
    expect(result.current.owned).toBe(result.current.base);
    act(() => result.current.owned.set(scope, draft));
    rerender({ selectedOwner: { ...owner, threadId: "another" } });
    expect(result.current.base.getDraftScopeKeys()).toEqual([scope]);
    expect(resolveComposerScopeOwner(result.current.base, scope)).toEqual({ state: "known", owner });
  });

  it("does not assign legacy scopes to the local or currently selected owner", () => {
    const { result } = renderHook(() => {
      const store = useComposerDraftStore();
      useOwnedComposerDraftStore(store, "thread:codex:legacy", owner);
      return store;
    });
    act(() => result.current.set("thread:codex:legacy", draft));
    expect(resolveComposerScopeOwner(result.current, "thread:codex:legacy"))
      .toEqual({ state: "unresolved" });
  });

  it("restores durable owner metadata with the draft text", () => {
    expect(snapshotFromDraftRecord({
      scopeKey: "thread:codex:off-page",
      scopeKind: "thread",
      threadOwner: owner,
      text: draft.draft,
      skillTokens: [],
      imageAttachments: [],
      status: "unsent",
      createdAt: 1,
      updatedAt: 1,
      contentHash: "fixture",
      charCount: draft.draft.length,
    })).toMatchObject({ draft: draft.draft, threadOwner: owner });
  });
});

it("separates same-id owners and rejects content written into the wrong owner scope", () => {
  const { result } = renderHook(useComposerDraftStore);
  const localOwner: ComposerThreadOwner = { ...owner, target: { scope: "local" } };
  const local = buildOwnedComposerScopeKey(localOwner);
  const remote = buildOwnedComposerScopeKey(owner);
  act(() => {
    result.current.set(local, { ...draft, draft: "Local text" });
    result.current.set(remote, { ...draft, draft: "Remote text" });
  });
  expect(result.current.get(local)).toMatchObject({ draft: "Local text", threadOwner: localOwner });
  expect(result.current.get(remote)).toMatchObject({ draft: "Remote text", threadOwner: owner });
  expect(() => result.current.set(local, { ...draft, threadOwner: owner })).toThrow("another thread owner");
  expect(result.current.get(local)?.draft).toBe("Local text");
});

it("preserves malformed legacy owner metadata without authorizing release", () => {
  const { result } = renderHook(useComposerDraftStore);
  const malformed = { backend: "codex", threadId: "legacy" } as ComposerThreadOwner;
  act(() => result.current.set("thread:codex:legacy", { ...draft, threadOwner: malformed }));
  expect(result.current.getScopeOwner?.("thread:codex:legacy")).toBeUndefined();
  expect(resolveComposerScopeOwner(result.current, "thread:codex:legacy")).toEqual({ state: "unresolved" });
  expect(result.current.get("thread:codex:legacy")?.draft).toBe(draft.draft);
});
