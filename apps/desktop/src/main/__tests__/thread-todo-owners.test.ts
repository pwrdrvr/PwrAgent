import { describe, expect, it, vi } from "vitest";
import type { ThreadTodo } from "@pwragent/shared";
import { listThreadTodosForAvailableOwners } from "../thread-todos/thread-todo-owners";

function todo(id: string, overrides: Partial<ThreadTodo> = {}): ThreadTodo {
  return { id, backend: "codex", threadId: id, kind: "review", status: "open",
    title: `Review ${id}`, createdAt: 1, updatedAt: 1, ...overrides };
}

describe("To-do owner eligibility", () => {
  it("excludes archived and missing owners, including an archive missed while the app was closed", async () => {
    const cards = [todo("active"), todo("archived", { backend: "acp:grok" }), todo("missing"),
      todo("archived-reminder", { kind: "reminder", threadId: "archived", backend: "acp:grok" })];
    const loadOwners = vi.fn(async () => [
      { id: "active", source: "codex" as const, title: "Active review" },
      { id: "archived", source: "acp:grok" as const, title: "Show reserve when primary plan exhausted", archivedAt: 2 },
    ]);
    expect(await listThreadTodosForAvailableOwners(cards, loadOwners)).toEqual([
      { ...cards[0], threadTitle: "Active review" },
    ]);
    expect(loadOwners).toHaveBeenCalledTimes(1);
    // Projection must not manufacture a resolution or alter persisted cards.
    expect(cards.every((card) => card.status === "open" && card.threadTitle === undefined)).toBe(true);
  });

  it("names a valid owner outside the loaded sidebar and distinguishes backends", async () => {
    const cards = [todo("same-id"), todo("same-id", { id: "acp-card", backend: "acp:grok" })];
    const result = await listThreadTodosForAvailableOwners(cards, async () => [
      { id: "same-id", source: "acp:grok", title: "Unloaded Grok thread" },
    ]);
    expect(result).toEqual([{ ...cards[1], threadTitle: "Unloaded Grok thread" }]);
  });

  it("does not accept a peer's row as the owner of a local card", async () => {
    const result = await listThreadTodosForAvailableOwners([todo("same-id")], async () => [
      { id: "same-id", source: "codex", title: "Peer thread", federation: {
        instanceLabel: "Peer", ref: { backend: "codex", threadId: "same-id", target: { scope: "remote", instanceId: "peer" } },
      } },
    ]);
    expect(result).toEqual([]);
  });

  it("reads the owner inventory once for many cards and does not read it for an empty queue", async () => {
    const cards = Array.from({ length: 500 }, (_, index) => todo(String(index), { threadId: "owner" }));
    const loadOwners = vi.fn(async () => [{ id: "owner", source: "codex" as const, title: "Owner" }]);
    expect(await listThreadTodosForAvailableOwners(cards, loadOwners)).toHaveLength(500);
    expect(loadOwners).toHaveBeenCalledTimes(1);
    loadOwners.mockClear();
    expect(await listThreadTodosForAvailableOwners([], loadOwners)).toEqual([]);
    expect(loadOwners).not.toHaveBeenCalled();
  });

  it("does not interpret an owner read failure as deletion or a resolution", async () => {
    const card = todo("owner");
    await expect(listThreadTodosForAvailableOwners([card], async () => { throw new Error("Owner unavailable"); }))
      .rejects.toThrow("Owner unavailable");
    expect(card.status).toBe("open");
    expect(await listThreadTodosForAvailableOwners([card], async () => [{ id: "owner", source: "codex", title: "Restored owner" }]))
      .toEqual([{ ...card, threadTitle: "Restored owner" }]);
  });
});
