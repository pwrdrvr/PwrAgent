import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { buildThreadIdentityKey, type AppServerThreadSummary } from "@pwragent/shared";
import { archiveCoordinatorStandIn } from "./helpers/archive-coordinator-stand-in";

const providers = ["codex", "claude", "acp:kimi"] as const;
const threadId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;

/** Exercise the archive coordinator's inventory without starting providers or maintenance. */
function inventoryFixture(rows: AppServerThreadSummary[], activeDuplicates = false) {
  const list = (source: string, archived: boolean) => rows.filter((thread) =>
    thread.source === source && (Boolean(thread.archivedAt) === archived || (activeDuplicates && !archived)));
  const host = {
    subAgentStartupReconciliation: Promise.resolve(),
    isBootstrapModeFn: () => false,
    isCodexBootstrapDeferredFn: () => false,
    listAllInstalledAcpThreads: vi.fn(async (_filter: unknown, archived: boolean) => list("acp:kimi", archived)),
  };
  return archiveCoordinatorStandIn({
    registry: () => host,
    providers: {
      codex: {
        listThreads: vi.fn(async ({ archived }: { archived: boolean }) => list("codex", archived)),
        listNativeSubAgentThreads: vi.fn(async () => []),
      },
      claude: { listThreads: vi.fn(async ({ archived }: { archived: boolean }) => list("claude", archived)) },
    },
  }) as unknown as { listThreadsForArchiveRetention(): Promise<AppServerThreadSummary[]> };
}

function thread(source: typeof providers[number], id: string, archived: boolean): AppServerThreadSummary {
  return { source, id, title: id, titleSource: "explicit", linkedDirectories: [], threadStatus: "idle",
    ...(archived ? { archivedAt: 1 } : {}) };
}

describe("archive retention provider inventory property", () => {
  it("contains an archived Claude thread alongside the other providers", async () => {
    const rows = providers.map((source) => thread(source, threadId(0), true));
    expect(await inventoryFixture(rows).listThreadsForArchiveRetention()).toEqual(expect.arrayContaining(rows));
  });

  it("matches each provider's archive/restore model, with active membership winning ambiguous reads", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.record({
      source: fc.constantFrom(...providers), id: fc.integer({ min: 0, max: 8 }), archived: fc.boolean(),
    }), { maxLength: 30 }), fc.boolean(), async (operations, activeDuplicates) => {
      // All providers share an id deliberately: identities must remain provider-scoped.
      const model = new Map(providers.map((source) => {
        const row = thread(source, threadId(0), true);
        return [buildThreadIdentityKey(source, row.id), row];
      }));
      for (const operation of operations) {
        const row = thread(operation.source, threadId(operation.id), operation.archived);
        model.set(buildThreadIdentityKey(row.source, row.id), row);
      }
      const actual = await inventoryFixture([...model.values()], activeDuplicates).listThreadsForArchiveRetention();
      const project = (rows: AppServerThreadSummary[]) => rows.map((row) =>
        [buildThreadIdentityKey(row.source, row.id), row.archivedAt !== undefined]).sort();
      expect(project(actual)).toEqual(project([...model.values()].map((row) =>
        activeDuplicates ? { ...row, archivedAt: undefined } : row)));
    }));
  });
});
