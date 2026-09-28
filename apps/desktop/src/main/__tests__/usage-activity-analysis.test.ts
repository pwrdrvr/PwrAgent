import { describe, expect, it, vi } from "vitest";
import type { AppServerReadThreadResponse } from "@pwragent/shared";
import { analyzeUsageActivity } from "../app-server/usage-activity-analysis";

const request = { backend: "codex" as const, threadId: "thread", model: "gpt-6-luna", entryLimit: 2, characterLimit: 1000 };
const replay = { entries: [1, 2, 3].map((id) => ({ type: "message" as const, id: String(id), role: "assistant" as const, text: String(id).repeat(800) })),
  messages: [], pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "earlier" } };

describe("bounded usage analysis", () => {
  it("reads a single recent page and disables execution/delegation without following cursors", async () => {
    const read = vi.fn(async () => ({ replay, backend: "codex", fetchedAt: 1, threadId: "thread" }) as AppServerReadThreadResponse);
    const generate = vi.fn<Parameters<typeof analyzeUsageActivity>[2]>(async () => ({ status: "ok" as const, object: { analysis: "Evidence is partial." } }));
    const result = await analyzeUsageActivity(request, read, generate);
    expect(read).toHaveBeenCalledExactlyOnceWith({ backend: "codex", threadId: "thread", limit: 10, viewOnly: true });
    expect(result).toMatchObject({ entries: 2, characters: 1000, truncated: true, hasEarlierHistory: true });
    expect(generate.mock.calls[0]?.[0]).toMatchObject({ model: "gpt-6-luna", disableExecution: true });
    const prompt = (generate.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).not.toContain("1".repeat(20));
    expect(prompt).toContain("3".repeat(20));
  });

  it("rejects oversized or malformed requests before reading or invoking a model", async () => {
    const read = vi.fn(); const generate = vi.fn();
    await expect(analyzeUsageActivity({ ...request, characterLimit: 40001 }, read, generate)).rejects.toThrow("40,000");
    await expect(analyzeUsageActivity({ ...request, entryLimit: NaN }, read, generate)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
});
