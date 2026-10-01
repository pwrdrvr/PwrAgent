import { expect, it, vi } from "vitest";
import { ArchiveCleanupReadPool } from "../app-server/archive-cleanup-read-pool";

it("shares a stale read's replacement without publishing stale archive evidence", async () => {
  const pool = new ArchiveCleanupReadPool(100);
  let finish!: (ids: Set<string>) => void;
  const gate = new Promise<Set<string>>((resolve) => { finish = resolve; });
  const load = vi.fn().mockImplementationOnce(() => gate)
    .mockResolvedValue(new Set(["newly-archived"]));
  const first = pool.read("codex", load);
  await Promise.resolve();
  pool.invalidate("codex");
  const second = pool.read("codex", load);
  expect(load).toHaveBeenCalledTimes(1);
  finish(new Set(["restored"]));
  const [a, b] = await Promise.all([first, second]);
  expect(a).toBe(b);
  expect(a.threadIds).toEqual(new Set(["newly-archived"]));
  expect(load).toHaveBeenCalledTimes(2);
});

it("bounds non-cancellable cleanup reads during sustained archive mutations", async () => {
  const pool = new ArchiveCleanupReadPool(100);
  const load = vi.fn(async () => {
    pool.invalidate("codex");
    return new Set<string>();
  });
  await expect(pool.read("codex", load)).rejects.toThrow("three cleanup reads");
  expect(load).toHaveBeenCalledTimes(3);
  load.mockImplementation(async () => new Set(["stable"]));
  expect((await pool.read("codex", load)).threadIds.has("stable")).toBe(true);
  expect(load).toHaveBeenCalledTimes(4);
});

it("expires evidence, isolates providers, and does not cache failures", async () => {
  let now = 0;
  const pool = new ArchiveCleanupReadPool(100, () => now);
  const load = vi.fn(async () => new Set<string>());
  await pool.read("codex", load);
  now = 99;
  await pool.read("codex", load);
  expect(load).toHaveBeenCalledTimes(1);
  await pool.read("acp:fixture", load);
  expect(load).toHaveBeenCalledTimes(2);
  now = 100;
  load.mockRejectedValueOnce(new Error("provider unavailable"));
  await expect(pool.read("codex", load)).rejects.toThrow("provider unavailable");
  await pool.read("codex", load);
  expect(load).toHaveBeenCalledTimes(4);
});
