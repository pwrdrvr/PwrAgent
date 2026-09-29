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

  it("pages back to a requested turn and analyzes only that turn's entries", async () => {
    const entry = (id: string, turn: string) => ({ type: "message" as const, id, role: "assistant" as const, text: `${id} `.repeat(30), turn: { id: turn } });
    const pages: Record<string, AppServerReadThreadResponse["replay"]> = {
      first: { entries: [entry("recent", "t3")], messages: [], pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "c1" } },
      c1: { entries: [entry("costly", "t1"), entry("other", "t2")], messages: [], pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: "c2" } },
    };
    const read = vi.fn(async (params: { before?: string }) => ({ replay: pages[params.before ?? "first"]!, backend: "codex", fetchedAt: 1, threadId: "thread" }) as AppServerReadThreadResponse);
    const generate = vi.fn<Parameters<typeof analyzeUsageActivity>[2]>(async () => ({ status: "ok" as const, object: { analysis: "Turn diagnosis." } }));
    const result = await analyzeUsageActivity({ ...request, turnId: "t1" }, read, generate);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread", limit: 10, viewOnly: true, before: "c1" });
    expect(result).toMatchObject({ scope: "turn", pagesRead: 2, entries: 1 });
    const prompt = (generate.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt;
    expect(prompt).toContain("costly");
    expect(prompt).not.toContain("other");
    expect(prompt).not.toContain("recent");
  });

  it("stops after five pages and falls back to the recent page when the turn is out of reach", async () => {
    let page = 0;
    const read = vi.fn(async (params: { before?: string }) => {
      if (!params.before) page = 0;
      page += 1;
      return { replay: { entries: [{ type: "message" as const, id: `p${page}`, role: "assistant" as const, text: `page ${params.before ?? "recent"}`, turn: { id: `t${page}` } }],
        messages: [], pagination: { supportsPagination: true, hasPreviousPage: true, previousCursor: `c${page}` } }, backend: "codex", fetchedAt: 1, threadId: "thread" } as AppServerReadThreadResponse;
    });
    const generate = vi.fn<Parameters<typeof analyzeUsageActivity>[2]>(async () => ({ status: "ok" as const, object: { analysis: "Recent diagnosis." } }));
    const result = await analyzeUsageActivity({ ...request, turnId: "missing" }, read, generate);
    // Five bounded pages, then one re-read of the recent page.
    expect(read).toHaveBeenCalledTimes(6);
    expect(read).toHaveBeenLastCalledWith({ backend: "codex", threadId: "thread", limit: 10, viewOnly: true });
    expect(result).toMatchObject({ scope: "recent", pagesRead: 5 });
    expect((generate.mock.calls[0] as unknown as [{ prompt: string }])[0].prompt).toContain("page recent");
  });

  it("rejects oversized or malformed requests before reading or invoking a model", async () => {
    const read = vi.fn(); const generate = vi.fn();
    await expect(analyzeUsageActivity({ ...request, characterLimit: 40001 }, read, generate)).rejects.toThrow("40,000");
    await expect(analyzeUsageActivity({ ...request, entryLimit: NaN }, read, generate)).rejects.toThrow();
    expect(read).not.toHaveBeenCalled(); expect(generate).not.toHaveBeenCalled();
  });
});
