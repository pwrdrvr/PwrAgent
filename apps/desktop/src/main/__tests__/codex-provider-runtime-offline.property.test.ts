import fc from "fast-check";
import { expect, it } from "vitest";
import type { CodexModelProviderSettings } from "@pwragent/shared/codex-model-providers";
import type { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { createProviderRuntimeClient } from "../codex-app-server/provider-runtime-client";

const provider: CodexModelProviderSettings = {
  id: "mathos", name: "MathOS", baseUrl: "https://mathos.example/v1",
};
const HISTORY_METHODS = ["archiveThread", "renameThread", "restoreThread", "deleteThread", "updateThreadMetadata"] as const;
type HistoryMethod = typeof HISTORY_METHODS[number];
type Call = { method: HistoryMethod; threadId: string };

function fixture() {
  const calls: Call[] = [];
  const client = {
    ...Object.fromEntries(HISTORY_METHODS.map((method) => [method, async ({ threadId }: { threadId: string }) => {
      calls.push({ method, threadId });
      return { threadId };
    }])),
    readThreadSummary: async (threadId: string) => ({ id: threadId }),
    modelProviderForThread: () => provider.id,
    onNotification: () => () => undefined,
    startThread: async () => ({ threadId: "new-thread" }),
    close: async () => undefined,
  } as unknown as CodexAppServerClient;
  return { calls, client };
}

async function manage(client: CodexAppServerClient, method: HistoryMethod, threadId: string) {
  if (method === "renameThread") return client.renameThread({ threadId, name: "Renamed offline" });
  if (method === "updateThreadMetadata") return client.updateThreadMetadata({ threadId, gitInfo: { branch: "main" } });
  return client[method]({ threadId });
}

it.each(["archiveThread", "renameThread"] as const)("keeps %s available offline for a discovery-only provider after app restart", async (method) => {
  const primary = fixture();
  let creations = 0;
  const client = createProviderRuntimeClient(primary.client, {
    resolveProviders: () => [provider],
    create: () => {
      creations += 1;
      throw new Error("Provider endpoint unavailable; no model IDs discovered.");
    },
  });
  await expect(manage(client, method, "persisted")).resolves.toEqual({ threadId: "persisted" });
  expect(primary.calls).toEqual([{ method, threadId: "persisted" }]);
  expect(creations).toBe(0);
});

it("routes persisted history operations without discovery until a runtime exists, then uses its owner until close", async () => {
  // Model: direct persisted operations never create an inference runtime.
  // Starting another thread on this provider creates one; close removes it.
  // Each history command targets a separate persisted thread, so deletion or
  // archiving does not invalidate later commands in the generated sequence.
  await fc.assert(fc.asyncProperty(
    fc.array(fc.constantFrom(...HISTORY_METHODS, "start" as const, "close" as const), { minLength: 1, maxLength: 25, size: "max" }),
    async (commands) => {
      const primary = fixture();
      const live = fixture();
      let creations = 0;
      let expectedCreations = 0;
      let hasRuntime = false;
      const expectedPrimary: Call[] = [];
      const expectedLive: Call[] = [];
      const client = createProviderRuntimeClient(primary.client, {
        resolveProviders: () => [provider],
        create: () => { creations += 1; return live.client; },
      });
      for (const [index, command] of commands.entries()) {
        if (command === "start") {
          await client.startThread({ model: "@mathos/fixture-model" });
          if (!hasRuntime) expectedCreations += 1;
          hasRuntime = true;
        } else if (command === "close") {
          await client.close();
          hasRuntime = false;
        } else {
          const threadId = `persisted-${index}`;
          await manage(client, command, threadId);
          (hasRuntime ? expectedLive : expectedPrimary).push({ method: command, threadId });
        }
        expect(primary.calls).toEqual(expectedPrimary);
        expect(live.calls).toEqual(expectedLive);
        expect(creations).toBe(expectedCreations);
      }
      await client.close();
    },
  ), { numRuns: 30, examples: [[["archiveThread"]], [["renameThread"]], [["start", "renameThread", "close", "archiveThread"]]] });
});
