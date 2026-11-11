import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import type { DesktopFederationRuntime } from "../federation/federation-runtime";
import { createFederatedThreadMutationHandler } from "../federation/federated-thread-mutation-service";

function fixture(initiallyArchived = false) {
  let ownerArchived = initiallyArchived;
  // Discovery metadata can outlive an archive event, and Codex's archived
  // listings need not supply an archive timestamp at all.
  let resolvedTimestamp: number | undefined;
  const summary = (): AppServerThreadSummary => ({
    source: "codex", id: "fixture-thread", title: "Fixture", titleSource: "explicit", linkedDirectories: [],
    threadStatus: "idle", archivedAt: resolvedTimestamp,
  });
  const effects: boolean[] = [];
  const backend = {
    resolveThread: vi.fn(async (): Promise<{ thread?: AppServerThreadSummary }> => ({ thread: summary() })),
    lookupArchivedThreads: vi.fn(async () => ({ threads: ownerArchived ? [summary()] : [] })),
    archiveThread: vi.fn(async () => {
      expect(ownerArchived).toBe(false);
      ownerArchived = true;
      effects.push(true);
      return { backend: "codex", threadId: "fixture-thread", archivedAt: 100, cleanup: [] };
    }),
    restoreThread: vi.fn(async () => {
      expect(ownerArchived).toBe(true);
      ownerArchived = false;
      effects.push(false);
      return { backend: "codex", threadId: "fixture-thread", restoredAt: 200 };
    }),
  };
  const otherOwner = { resolveThread: vi.fn(), lookupArchivedThreads: vi.fn(), archiveThread: vi.fn(), restoreThread: vi.fn() };
  const runtime = {
    connectedPeerTargets: () => ["fixture-owner", "other-owner"].map((instanceId) => ({
      target: { scope: "remote", instanceId }, label: instanceId,
      capabilities: ["thread_navigation", "turn_control"],
    })),
    remoteBackend: ({ instanceId }: { instanceId: string }) => instanceId === "fixture-owner" ? backend : otherOwner,
  } as unknown as DesktopFederationRuntime;
  const handler = createFederatedThreadMutationHandler({ runtime: () => runtime });
  return {
    backend, otherOwner, effects,
    ownerArchived: () => ownerArchived,
    publishSummary: (archived: boolean) => { resolvedTimestamp = archived ? 100 : undefined; },
    mutate: (archive: boolean, dryRun = false) => handler({
      backend: "codex", threadId: "fixture-thread", instanceId: "fixture-owner", archive, dryRun,
    }),
  };
}

describe("federated archive membership oracle", () => {
  it("restores immediately after an acknowledged archive without delivering its summary event", async () => {
    const owner = fixture();
    await expect(owner.mutate(true)).resolves.toMatchObject({ instanceId: "fixture-owner" });
    await expect(owner.mutate(false)).resolves.toMatchObject({ instanceId: "fixture-owner" });
    expect(owner.effects).toEqual([true, false]);
    expect(owner.ownerArchived()).toBe(false);
  });

  it("accepts owner archive membership without a timestamp when active resolution misses", async () => {
    const owner = fixture(true);
    owner.backend.resolveThread.mockResolvedValue({});
    await expect(owner.mutate(false, true)).resolves.toMatchObject({ instanceId: "fixture-owner" });
    expect(owner.effects).toEqual([]);
    await expect(owner.mutate(false)).resolves.toMatchObject({ instanceId: "fixture-owner" });
    expect(owner.effects).toEqual([false]);
    expect(owner.backend.lookupArchivedThreads).toHaveBeenCalledTimes(2);
  });

  it("preserves owner lookup failures instead of guessing membership from the summary", async () => {
    const owner = fixture();
    owner.backend.lookupArchivedThreads.mockRejectedValue(new Error("Owner lookup failed"));
    await expect(owner.mutate(true)).rejects.toThrow("Owner lookup failed");
    expect(owner.effects).toEqual([]);
  });

  it("uses owner membership for every mutation and preview despite arbitrary summary delivery", async () => {
    await fc.assert(fc.asyncProperty(
      fc.boolean(),
      fc.array(fc.record({ archive: fc.boolean(), dryRun: fc.boolean(), summary: fc.option(fc.boolean(), { nil: undefined }) }),
        { minLength: 1, maxLength: 40 }),
      async (initiallyArchived, commands) => {
        const owner = fixture(initiallyArchived);
        let expectedArchived = initiallyArchived;
        const expectedEffects: boolean[] = [];
        for (const command of commands) {
          if (command.summary !== undefined) owner.publishSummary(command.summary);
          if (command.archive === expectedArchived) {
            await expect(owner.mutate(command.archive, command.dryRun)).rejects.toMatchObject({ code: "invalid_arguments" });
          } else {
            await expect(owner.mutate(command.archive, command.dryRun)).resolves.toMatchObject({ instanceId: "fixture-owner" });
            if (!command.dryRun) {
              expectedArchived = command.archive;
              expectedEffects.push(command.archive);
            }
          }
          expect(owner.ownerArchived()).toBe(expectedArchived);
          expect(owner.effects).toEqual(expectedEffects);
        }
        for (const method of Object.values(owner.otherOwner)) expect(method).not.toHaveBeenCalled();
      },
    ), { numRuns: 100 });
  });
});
