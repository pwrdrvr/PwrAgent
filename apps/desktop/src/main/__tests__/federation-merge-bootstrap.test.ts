import { describe, expect, it, vi } from "vitest";
import { FederationMergeBootstrap } from "../federation/federation-merge-bootstrap";

describe("resumable merge bootstrap", () => {
  it("resumes an interrupted baseline and skips a completed warm baseline", async () => {
    const bootstrap = new FederationMergeBootstrap<{ id: number; dx: number | null }>();
    const rows = Array.from({ length: 201 }, (_, id) => ({ id, dx: id % 2 ? null : id }));
    const load = vi.fn(async () => rows);
    const pages = await bootstrap.read(load, { protocol: 1 }, 0);
    const generation = pages[0]!.generation;
    const remaining = await bootstrap.read(load, { protocol: 1, generation, nextPage: 1 }, 1);
    expect(remaining).toEqual(pages.slice(1));
    expect([pages[0]!, ...remaining].flatMap((page) => page.entries)).toEqual(rows);
    expect(await bootstrap.read(load, { protocol: 1, generation, nextPage: 3 }, 2)).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("restarts stale generations after changes or expiry without dropping tombstones", async () => {
    const bootstrap = new FederationMergeBootstrap<{ id: string; dx: number | null }>();
    const load = vi.fn().mockResolvedValueOnce([{ id: "thread", dx: 1 }])
      .mockResolvedValue([{ id: "thread", dx: null }]);
    const first = await bootstrap.read(load, { protocol: 1 }, 0);
    const cursor = { protocol: 1 as const, generation: first[0]!.generation, nextPage: 1 };
    bootstrap.invalidate();
    const changed = await bootstrap.read(load, cursor, 1);
    expect(changed[0]!.entries).toEqual([{ id: "thread", dx: null }]);
    expect(changed[0]!.generation).not.toBe(cursor.generation);
    const expired = await bootstrap.read(load, {
      protocol: 1, generation: changed[0]!.generation, nextPage: 1,
    }, 60_001);
    expect(expired[0]!.entries).toEqual([{ id: "thread", dx: null }]);
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("shares cold loading but never caches a baseline invalidated while loading", async () => {
    const bootstrap = new FederationMergeBootstrap<number>();
    let release!: (entries: number[]) => void;
    const load = vi.fn(() => new Promise<number[]>((resolve) => { release = resolve; }));
    const first = bootstrap.read(load, { protocol: 1 }, 0);
    const second = bootstrap.read(load, { protocol: 1 }, 0);
    bootstrap.invalidate();
    release([1]);
    expect(await second).toEqual(await first);
    const freshLoad = vi.fn(async () => [2]);
    expect((await bootstrap.read(freshLoad, { protocol: 1 }, 1))[0]!.entries).toEqual([2]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
