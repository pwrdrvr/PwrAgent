import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import fc from "fast-check";
import { threadTodoThreadKey, type ThreadTodo, type ThreadTodoFeedDelta, type ThreadReviewIdentity } from "@pwragent/shared";
import { useThreadTodos } from "../useThreadTodos";

afterEach(cleanup);
const selected: ThreadReviewIdentity = { backend: "codex", threadId: "same", federationTarget: { scope: "remote", instanceId: "peer" } };
const key = "remote:peer:codex:same";
const remote = (title: string): ThreadTodo => ({ id: "remote-todo:peer:remote", backend: "codex", threadId: "same",
  federationTarget: selected.federationTarget, title, kind: "reminder", status: "open", createdAt: 1, updatedAt: 1 });
const local: ThreadTodo = { id: "local", backend: "codex", threadId: "same", title: "Local card", kind: "reminder", status: "open", createdAt: 0, updatedAt: 0 };

it("keeps the selected owner's cards over feed overlays, without invalidating them for another thread's deltas", async () => {
  // Owner oracle: listThreadTodos owns the selected remote thread; the feed
  // owns every other thread, including a local thread with the same id.
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("other", "owner", "feed", "leave", "select"),
    { minLength: 4, maxLength: 15, size: "max" }), async (commands) => {
    let ownerCard = remote("Owner initial");
    let feedCard = remote("Feed initial");
    let delta: (event: ThreadTodoFeedDelta) => void = () => {};
    const api = {
      snapshotThreadTodos: async () => ({ epoch: "e", revision: 0, todos: [local, feedCard] }),
      listThreadTodos: vi.fn(async () => ({ todos: [structuredClone(ownerCard)] })),
      onThreadTodosDelta: (listener: typeof delta) => { delta = listener; return () => {}; },
    };
    let selection: ThreadReviewIdentity | undefined = selected;
    const hook = renderHook(({ selection }) => useThreadTodos(api, "", selection), { initialProps: { selection: selection as ThreadReviewIdentity | undefined } });
    try {
      await waitFor(() => expect(hook.result.current.openByThreadKey.get(key)?.[0]?.title).toBe(ownerCard.title));
      let revision = 0;
      for (const [step, command] of commands.entries()) {
        const before = hook.result.current.openByThreadKey;
        if (command === "leave" || command === "select") {
          selection = command === "leave" ? undefined : selected;
          await act(async () => hook.rerender({ selection }));
        } else {
          const card: ThreadTodo = command === "other" ? { ...local, id: "offscreen", threadId: "other", title: `Other ${step}` }
            : remote(`${command} ${step}`);
          if (command !== "other") {
            feedCard = card;
            if (command === "owner") ownerCard = { ...card, title: `Owner ${step}`, updatedAt: step + 10 };
          }
          const reads = api.listThreadTodos.mock.calls.length;
          await act(async () => delta({ epoch: "e", revision: ++revision, upserts: [card] }));
          if (command === "other") {
            expect(hook.result.current.openByThreadKey.get(key)).toBe(before.get(key));
            expect(api.listThreadTodos.mock.calls.length).toBe(reads);
          }
          expect(hook.result.current.openByThreadKey.get("codex:same")).toBe(before.get("codex:same"));
        }
        expect(hook.result.current.openByThreadKey.get("codex:same")).toEqual([local]);
        expect(hook.result.current.openByThreadKey.get(key)).toEqual([selection ? ownerCard : feedCard]);
        expect(hook.result.current.openTodos.filter((card) => threadTodoThreadKey(card) === key)).toHaveLength(1);
      }
    } finally { hook.unmount(); }
  }), { numRuns: 20 });
});
