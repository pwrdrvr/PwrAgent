import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { withAntigravityUsageCooldown } from "../acp/antigravity-usage-cooldown";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";

it.each([4, 8, 16])("admits one CLI reader when %i gestures race on a cold root", async (gestures) => {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-test-agy-cooldown-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const read = vi.fn(async (markStarted: () => void) => {
    markStarted();
    return "usage";
  });
  const results = await Promise.all(Array.from({ length: gestures }, () =>
    withAntigravityUsageCooldown(read, root),
  ));
  expect(results.filter((result) => result === "usage")).toHaveLength(1);
  expect(read).toHaveBeenCalledOnce();
});

it("admits one shared-root attempt per cooldown, even across owners, failures and restarts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-test-agy-cooldown-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  let now = 1_800_000_000_000;
  const clock = () => now;
  const started = Promise.withResolvers<void>();
  const initial = Promise.withResolvers<string>();
  const read = vi.fn((markStarted: () => void) => {
    markStarted();
    started.resolve();
    return initial.promise;
  });
  const attempt = withAntigravityUsageCooldown(read, root, clock);
  const finished = expect(attempt).rejects.toThrow("CLI failed");
  try {
    await started.promise;
    for (const gestures of [4, 8, 16]) {
      await expect(Promise.all(Array.from({ length: gestures }, () =>
        withAntigravityUsageCooldown(read, root, clock),
      ))).resolves.toEqual(Array(gestures).fill(undefined));
      expect(read).toHaveBeenCalledOnce();
    }
  } finally {
    now += 20_000;
    initial.reject(new Error("CLI failed"));
    await finished;
  }
  now += 15 * 60_000 - 1;
  await expect(withAntigravityUsageCooldown(read, root, clock)).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledOnce();
  now += 1;
  read.mockImplementation(async (markStarted) => {
    markStarted();
    return "usage";
  });
  await expect(withAntigravityUsageCooldown(read, root, clock)).resolves.toBe("usage");
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps the live reservation exclusive after the crash deadline even if two owners try to recover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-test-agy-cooldown-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const first = withAntigravityUsageCooldown(async (markStarted) => {
    markStarted?.();
    entered.resolve();
    await finish.promise;
  }, root);
  const rival = vi.fn(async () => {});
  try {
    await entered.promise;
    now.mockReturnValue(Date.now() + 17 * 60_000);
    await Promise.all([withAntigravityUsageCooldown(rival, root), withAntigravityUsageCooldown(rival, root)]);
    expect(rival).not.toHaveBeenCalled();
  } finally {
    finish.resolve();
    await Promise.allSettled([first]);
    now.mockRestore();
  }
});

it("restores eligibility when no CLI process starts and budgets writes for an admitted read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-test-agy-cooldown-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
  try {
    // Initialize the database without reserving an attempt.
    const read = vi.fn(async () => undefined);
    await withAntigravityUsageCooldown(read, root, Date.now, () => false);
    expect(read).not.toHaveBeenCalled();
    // Cancellation while preparing the command never reaches markStarted.
    await withAntigravityUsageCooldown(read, root);
    const { result, writes } = await measureSqliteWrites(() =>
      withAntigravityUsageCooldown(async (markStarted) => {
        markStarted();
        return "usage";
      }, root));
    expect(result).toBe("usage");
    expectSqliteWriteBudget({
      scenario: "antigravity-usage-reservation",
      note: "one CLI attempt reserves a crash deadline, then records completion",
      writes,
    });
  } finally {
    vi.unstubAllEnvs();
  }
});
