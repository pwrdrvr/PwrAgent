import { afterEach, describe, expect, it, vi } from "vitest";
import { normalizeClaudeTitle, requestClaudeTitle, type ClaudeTitleQuery } from "../claude/claude-titles";

afterEach(() => { vi.useRealTimers(); });

describe("Claude native titles", () => {
  it("bounds native title context and retains the query method receiver", async () => {
    const generateSessionTitle = vi.fn(function(this: ClaudeTitleQuery) {
      expect(this).toBe(query);
      return Promise.resolve("  Native\nname\u0007  ");
    });
    const query = { generateSessionTitle } as unknown as ClaudeTitleQuery;
    await expect(requestClaudeTitle(query, "x".repeat(10_000), new AbortController().signal)).resolves.toBe("Native name");
    expect(generateSessionTitle).toHaveBeenCalledWith("x".repeat(1000), { persist: true });
  });

  it("bounds a hung native request without failing the caller", async () => {
    vi.useFakeTimers();
    const query = { generateSessionTitle: () => new Promise(() => {}) } as unknown as ClaudeTitleQuery;
    const pending = requestClaudeTitle(query, "Name this work", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(pending).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("stops waiting when the turn is interrupted (already aborted=%s)", async (alreadyAborted) => {
    const controller = new AbortController();
    const generateSessionTitle = vi.fn(() => new Promise<string | null>(() => {}));
    const query = { generateSessionTitle } as unknown as ClaudeTitleQuery;
    if (alreadyAborted) controller.abort();
    const pending = requestClaudeTitle(query, "Name this work", controller.signal);
    controller.abort();
    await expect(pending).resolves.toBeUndefined();
    expect(generateSessionTitle).toHaveBeenCalledTimes(alreadyAborted ? 0 : 1);
  });

  it("supports SDKs without the optional control method", async () => {
    await expect(requestClaudeTitle({} as ClaudeTitleQuery, "Name this work", new AbortController().signal)).resolves.toBeUndefined();
  });

  it("rejects blank names and bounds stored provider names", () => {
    expect(normalizeClaudeTitle(" \n\u0007")).toBeUndefined();
    expect(normalizeClaudeTitle("a".repeat(10_000))).toHaveLength(200);
  });
});
