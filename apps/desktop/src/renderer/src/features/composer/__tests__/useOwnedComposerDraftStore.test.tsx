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
    const { result, rerender } = renderHook(({ scope }) => {
      const base = useComposerDraftStore();
      const owned = useOwnedComposerDraftStore(base, scope, owner);
      return { base, owned };
    }, { initialProps: { scope: "thread:codex:off-page" } });
    expect(result.current.owned).toBe(result.current.base);
    act(() => result.current.owned.set("thread:codex:off-page", draft));
    rerender({ scope: "thread:codex:another" });
    expect(result.current.base.getDraftScopeKeys()).toEqual(["thread:codex:off-page"]);
    expect(resolveComposerScopeOwner(result.current.base, "thread:codex:off-page"))
      .toEqual({ state: "known", owner });
  });

  it("does not assign legacy scopes to the local or currently selected owner", () => {
    const { result } = renderHook(useComposerDraftStore);
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
