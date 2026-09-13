import { describe, expect, it } from "vitest";
import { buildThreadPricingDisplay } from "@pwragent/shared";
import type { AppServerReadThreadResponse } from "@pwragent/shared";
import { conditionalThreadRead } from "../app-server/conditional-thread-read";

function response(): AppServerReadThreadResponse {
  const text = "x".repeat(1_700_000);
  return {
    backend: "codex", fetchedAt: 100, readDurationMs: 15, threadId: "thread",
    replay: {
      entries: [{ type: "message", id: "entry", role: "assistant", text }],
      messages: [{ id: "entry", role: "assistant", text }],
      pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "opaque-cursor" },
    },
  };
}

describe("conditional thread pages", () => {
  it("preserves legacy reads and returns a complete first page without truncation", () => {
    const original = response();
    expect(conditionalThreadRead(original, undefined)).toBe(original);
    expect(conditionalThreadRead(original, "")).toEqual({
      ...original, replayRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  it("revalidates repeated multi-megabyte responses in fewer than 400 bytes", () => {
    const original = response();
    const first = conditionalThreadRead(original, "");
    for (const fetchedAt of [200, 300]) {
      const repeated = conditionalThreadRead({ ...original, fetchedAt, readDurationMs: 19 }, first.replayRevision);
      expect(repeated).toMatchObject({ unchanged: true, replayRevision: first.replayRevision, fetchedAt });
      expect(Buffer.byteLength(JSON.stringify(repeated))).toBeLessThan(400);
    }
    expect(original.replay.entries[0]).toHaveProperty("text", "x".repeat(1_700_000));
    expect(first.replay.pagination.previousCursor).toBe("opaque-cursor");
  });

  it("revalidates the whole response, not just transcript text or a navigation timestamp", () => {
    const original = response();
    const first = conditionalThreadRead(original, "");
    for (const changed of [
      { ...original, threadStatus: "active" as const },
      { ...original, tokenMiserEnabled: true },
      { ...original, pendingRequest: {
        method: "item/tool/requestUserInput",
        params: { threadId: "thread", requestId: "approval", prompt: "Still awaiting an answer" },
      } },
      { ...original, replay: { ...original.replay, pagination: { ...original.replay.pagination, previousCursor: "new-cursor" } } },
      { ...original, replay: { ...original.replay, entries: [] } },
    ]) {
      const result = conditionalThreadRead(changed, first.replayRevision);
      expect(result.unchanged).not.toBe(true);
      expect(result.replayRevision).not.toBe(first.replayRevision);
      expect(result.replay).toBe(changed.replay);
    }
  });
});


it("keeps repeated unchanged display pages within a 40 KB budget for 100 revalidations", () => {
  const original: AppServerReadThreadResponse = {
    backend: "codex", fetchedAt: 1, threadId: "thread",
    replay: { entries: [], messages: [], pagination: { supportsPagination: true, hasPreviousPage: false } },
    display: { revision: "collection", pricing: buildThreadPricingDisplay({}), nextCursor: "collection:20",
      subAgents: Array.from({ length: 20 }, (_, i) => ({ monitorId: String(i), createdAt: 1, updatedAt: 1,
        status: "success", task: "x".repeat(10_000) })) },
  };
  const initial = conditionalThreadRead(original, "");
  expect(Buffer.byteLength(JSON.stringify(initial))).toBeGreaterThan(200_000);
  let bytes = 0;
  for (let i = 0; i < 100; i++) {
    const revalidated = conditionalThreadRead({ ...original, fetchedAt: i + 2 }, initial.replayRevision);
    expect(revalidated.unchanged).toBe(true);
    expect(revalidated.display).toBeUndefined();
    bytes += Buffer.byteLength(JSON.stringify(revalidated));
  }
  expect(bytes).toBeLessThan(40_000);
  const changed = conditionalThreadRead({ ...original, display: { ...original.display!, revision: "changed" } }, initial.replayRevision);
  expect(changed.unchanged).not.toBe(true);
  expect(changed.display?.revision).toBe("changed");
});
