import fc from "fast-check";
import { afterEach, expect, it, vi } from "vitest";
import { closeElectronApplication } from "../../../e2e/fixtures/electron-app";
import { createCloseHarness } from "./fixtures/electron-close-harness";

afterEach(() => {
  vi.restoreAllMocks();
});

async function checkSessionReadiness(sessionCount: number, choices: number[]): Promise<void> {
  const cacheComplete = Array.from({ length: sessionCount }, () => false);
  const pending = new Map<number, { release(): void }>();
  const prematureDisposal: string[] = [];
  let workAvailable: (() => void) | undefined;
  const operation = (index: number, cache = false) => () => new Promise<void>((resolve) => {
    pending.set(index, { release: () => {
      if (cache) cacheComplete[index] = true;
      resolve();
    } });
    workAvailable?.();
    workAvailable = undefined;
  });
  const sessions = cacheComplete.map((_, index) => ({
    closeAllConnections: operation(index),
    cookies: { flushStore: operation(index) },
    clearData: operation(index, true),
  }));
  const observeDisposal = (stage: string) => {
    // Every owned session retains its native context until callbacks finish,
    // even though Playwright has detached and renderers have already closed.
    if (cacheComplete.some((complete) => !complete)) prematureDisposal.push(stage);
  };
  const harness = createCloseHarness([...sessions, sessions[0]], {
    installed: true,
    onNativeQuit: () => observeDisposal("native-quit"),
  });
  const closing = closeElectronApplication(harness.electronApp);
  // Only complete operations the real implementation has requested. Choose
  // among sessions, preserving connections -> cookies -> cache within each.
  for (let step = 0; step < sessionCount * 3; step += 1) {
    if (!pending.size) await new Promise<void>((resolve) => { workAvailable = resolve; });
    const available = [...pending.keys()].sort((a, b) => a - b);
    const index = available[choices[step] % available.length];
    const work = pending.get(index)!;
    pending.delete(index);
    work.release();
    await Promise.resolve();
  }
  await expect(closing).resolves.toMatchObject({ forceExitOutcome: "not-needed" });
  expect(prematureDisposal).toEqual([]);
  expect(harness.close).toHaveBeenCalledOnce();
  expect(cacheComplete.every(Boolean)).toBe(true);
}

it("a pending cache callback retains its native session context until completion", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await checkSessionReadiness(1, Array.from({ length: 9 }, () => 0));
});

it("preserves session ownership for generated callback completion orders", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  await fc.assert(fc.asyncProperty(
    fc.integer({ min: 1, max: 3 }),
    fc.array(fc.integer({ min: 0, max: 8 }), { minLength: 9, maxLength: 9 }),
    async (sessionCount, choices) => { await checkSessionReadiness(sessionCount, choices); },
  ), { numRuns: 25 });
});
