import { createOverlayStoreMock, MockBackendClient } from "./helpers/backend-registry-fixture";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import { expect, it, vi } from "vitest";

it("requires a workspace for Codex forks when a directory request has no usable path", async () => {
  const blankPath = fc.option(
    fc.array(fc.constantFrom(" ", "\t", "\r", "\n", "\u00a0"), { maxLength: 12 })
      .map((characters) => characters.join("")),
    { nil: undefined },
  );
  await fc.assert(fc.asyncProperty(blankPath, fc.constantFrom("local", "worktree"), async (directoryPath, workMode) => {
    const codexClient = new MockBackendClient({ initializeResult: { methods: ["thread/fork"] } });
    const scratchPath = "/tmp/fresh-fork-workspace";
    const createScratchProjectDirectory = vi.fn(async () => scratchPath);
    const registry = createDesktopBackendRegistry({
      codexClient,
      overlayStore: createOverlayStoreMock(),
      createScratchProjectDirectory,
    });
    try {
      const fork = registry.forkThread({
        backend: "codex",
        sourceThreadId: "thread-parent",
        directoryKind: "directory",
        directoryPath,
        workMode,
      });
      if (workMode === "worktree") {
        await expect(fork).rejects.toThrow("Requested worktree workspace");
        expect(codexClient.lastForkThreadParams).toBeUndefined();
        expect(createScratchProjectDirectory).not.toHaveBeenCalled();
      } else {
        await fork;
        expect(codexClient.lastForkThreadParams?.cwd).toBe(scratchPath);
      }
    } finally {
      await registry.close();
    }
  }), { numRuns: 20, examples: [[undefined, "local"], [undefined, "worktree"]] });
});
