import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { withAntigravityUsageCooldown } from "../acp/antigravity-usage-cooldown";

it.each([4, 8, 16])("admits one CLI reader when %i gestures race on a cold root", async (gestures) => {
  const root = await mkdtemp(path.join(tmpdir(), "pwragent-test-agy-cooldown-"));
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }); });
  const read = vi.fn(async () => "usage");
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
  const read = vi.fn(() => initial.promise);
  const attempt = withAntigravityUsageCooldown(read.mockImplementationOnce(() => {
    started.resolve();
    return initial.promise;
  }), root, clock);
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
  read.mockResolvedValue("usage");
  await expect(withAntigravityUsageCooldown(read, root, clock)).resolves.toBe("usage");
  expect(read).toHaveBeenCalledTimes(2);
});
