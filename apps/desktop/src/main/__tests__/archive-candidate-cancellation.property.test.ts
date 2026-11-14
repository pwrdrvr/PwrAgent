import { expect, it, vi } from "vitest";
import fc from "fast-check";
import { archiveCoordinatorStandIn } from "./helpers/archive-coordinator-stand-in";

const timer = vi.hoisted(() => ({ target: 1, calls: 0, entered: () => {}, release: () => {} }));

// Model a host timer that has not elapsed. Cancellation must wake the owned
// rest without advancing time or waiting for its ordinary completion.
vi.mock("node:timers/promises", () => ({ setTimeout: async (_ms: number, _value?: unknown,
  options?: { signal?: AbortSignal }) => {
  timer.calls += 1;
  if (timer.calls !== timer.target) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(new Error("Aborted"));
    timer.release = () => { options?.signal?.removeEventListener("abort", abort); resolve(); };
    options?.signal?.addEventListener("abort", abort, { once: true });
    timer.entered();
  });
} }));

it("shutdown wakes any owned discovery rest without waiting for elapsed time (model)", async () => {
  await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 5 }), async (boundary) => {
    timer.target = boundary;
    timer.calls = 0;
    const entered = new Promise<void>((resolve) => { timer.entered = resolve; });
    const coordinator = archiveCoordinatorStandIn({
      registry: () => ({ subAgentStartupReconciliation: Promise.resolve(),
        isBootstrapModeFn: () => false, isCodexBootstrapDeferredFn: () => false }),
      providers: { codex: { listArchiveCleanupThreadsPage: vi.fn(async () => ({ threads: [] })) },
        acp: { archiveCleanupBackendIds: async () => [] }, claude: { listThreads: async () => [] } },
    });
    const listing = coordinator.listAutoArchiveCandidates().catch(() => "cancelled");
    await entered;
    let closed = false;
    const closing = coordinator.stopThreadArchiveSweeper()!.then(() => { closed = true; });
    try {
      for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
      expect(closed).toBe(true);
      expect(timer.calls).toBe(boundary);
    } finally {
      timer.release();
      await closing;
      expect(await listing).toBe("cancelled");
    }
  }), { numRuns: 10 });
});
