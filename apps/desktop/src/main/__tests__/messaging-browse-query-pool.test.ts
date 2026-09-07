import { expect, it, vi } from "vitest";
import type { NavigationQueryRequest, NavigationThreadSummary } from "@pwragent/shared";
import { NavigationQueryStore } from "../app-server/navigation-query-store";
import { MessagingBrowseQueryPool } from "../messaging/core/messaging-browse-query-pool";

function fixture() {
  let time = 1000;
  const local = new NavigationQueryStore({ now: () => time });
  const peer = new NavigationQueryStore({ now: () => time });
  const read = vi.fn(async (request: NavigationQueryRequest) => {
    const remote = request.federationTarget?.scope === "remote";
    const threads: NavigationThreadSummary[] = Array.from({ length: 30 }, (_, index) => ({
      id: `same-${index}`, source: "codex", title: remote ? "Peer" : "Local", titleSource: "explicit",
      updatedAt: 100 - index * 2 + (remote ? 1 : 0), linkedDirectories: [], inbox: { inInbox: false },
    }));
    return (remote ? peer : local).readPage({ scopeKey: "test", request, loadIndex: async () => ({ threads, directories: [] }) });
  });
  const pool = new MessagingBrowseQueryPool(read, () => time);
  const request = { sessionId: "session", query: { kind: "messaging-threads" as const }, pageSize: 8, pageIndex: 0,
    owners: [{ label: "Local" }, { target: { scope: "remote" as const, instanceId: "peer" }, label: "Peer" }] };
  return { pool, read, request, advance: (ms: number) => { time += ms; } };
}

it("merges small owner pages without conflating equal local and remote thread ids", async () => {
  const { pool, read, request } = fixture();
  const first = await pool.read(request);
  expect(first.threads).toHaveLength(8);
  expect(first.totalItems).toBe(60);
  expect(first.threads.slice(0, 2).map((row) => [row.id, row.ref.ownerInstanceId])).toEqual([["same-0", "peer"], ["same-0", undefined]]);
  expect(read).toHaveBeenCalledTimes(2);
  const second = await pool.read({ ...request, pageIndex: 1 });
  expect(second.threads[0]?.id).toBe("same-4");
  expect(second.threads).toHaveLength(8);
  // One owner needs a look-ahead page before selecting the final merged row.
  expect(read).toHaveBeenCalledTimes(3);
  expect(await pool.read(request)).toBe(first);
  await pool.read({ ...request, pageIndex: 2 });
  expect(read).toHaveBeenCalledTimes(4);
  expect(read.mock.calls.every(([value]) => value.pageSize === 8 && value.deadlineAt !== undefined)).toBe(true);
});

it("coalesces concurrent demand for the same browser page", async () => {
  const { pool, read, request } = fixture();
  const [first, duplicate] = await Promise.all([pool.read(request), pool.read(request)]);
  expect(duplicate).toBe(first);
  expect(read).toHaveBeenCalledTimes(2);
});

it("rebaselines expired history explicitly instead of jumping through unbounded pages", async () => {
  const { pool, request, advance } = fixture();
  await pool.read(request);
  advance(60_001);
  const page = await pool.read({ ...request, pageIndex: 12 });
  expect(page.pageIndex).toBe(0);
  expect(page.notes.join(" ")).toContain("expired");
  expect(page.threads).toHaveLength(8);
});

it("reports unavailable owners and omitted owners instead of certifying complete fleet results", async () => {
  const { pool, request, read } = fixture();
  const original = read.getMockImplementation()!;
  read.mockImplementation(async (value) => {
    if (value.federationTarget?.scope === "remote") throw new Error("Peer disconnected");
    return original(value);
  });
  const page = await pool.read({ ...request, omittedOwners: 3 });
  expect(page.totalItems).toBe(30);
  expect(page.notes.join(" ")).toContain("Peer disconnected");
  expect(page.notes.join(" ")).toContain("3 owners");
});

it("does not retain or publish an owner reply after its browser closes", async () => {
  const { request, read } = fixture();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const pool = new MessagingBrowseQueryPool(async (value) => { await pending; return read(value); });
  const result = pool.read(request);
  await Promise.resolve();
  pool.clear();
  release();
  await expect(result).rejects.toThrow("superseded");
});
