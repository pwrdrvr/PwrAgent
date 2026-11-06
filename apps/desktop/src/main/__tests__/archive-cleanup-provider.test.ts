import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { ArchiveCleanupTransport } from "./fixtures/archive-cleanup-transport";
import { archiveCleanupWorkspaceFilter } from "../app-server/archive-cleanup-workspace-scope";
import budgets from "./fixtures/archive-cleanup-budgets.json";

vi.mock("../codex-app-server/stdio-transport", async () => ({
  StdioJsonRpcTransport: (await import("./fixtures/archive-cleanup-transport")).ArchiveCleanupTransport,
}));
vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

describe("archive cleanup provider slices", () => {
  it("owns one RPC page and one discovery at a time, sharing canonical observations across pages", async () => {
    const directory = { id: "worktree", kind: "worktree" as const, label: "repo", path: "/fixture/repo", worktreePath: "/fixture/project" };
    const checkpoint = vi.fn(async () => {});
    const enrich = vi.fn(async () => ({ linkedDirectories: [directory] }));
    const client = new CodexAppServerClient({ threadDirectoryEnricher: enrich });
    try {
      const directoryObservations = new Map();
      const first = await client.listArchiveCleanupThreadsPage({ archived: true, limit: 25, checkpoint, directoryObservations });
      expect(first.threads[0]?.linkedDirectories).toEqual([directory]);
      expect(first.nextCursor).toBe("1");
      expect(ArchiveCleanupTransport.latest.listings).toHaveLength(1);
      await client.listArchiveCleanupThreadsPage({ archived: true, cursor: first.nextCursor, limit: 25, checkpoint, directoryObservations });
      expect(ArchiveCleanupTransport.latest.listings).toHaveLength(2);
      // Activity may change during the paced scan without changing ownership.
      // The cursor must therefore follow creation order on every page.
      expect(ArchiveCleanupTransport.latest.listings).toEqual([
        expect.objectContaining({ sortKey: "created_at" }),
        expect.objectContaining({ sortKey: "created_at", cursor: "1" }),
      ]);
      expect(enrich).toHaveBeenCalledOnce();
      expect(checkpoint).toHaveBeenCalledOnce();
    } finally { await client.close(); }
  });

  it("fails closed when canonical discovery fails or the provider exceeds its page budget", async () => {
    const client = new CodexAppServerClient({ threadDirectoryEnricher: async () => { throw new Error("canonical discovery unavailable"); } });
    try {
      await expect(client.listArchiveCleanupThreadsPage({ archived: true, limit: 25, checkpoint: async () => {} })).rejects.toThrow("canonical discovery unavailable");
      // The contrived transport's active page has two rows.
      await expect(client.listArchiveCleanupThreadsPage({ archived: false, limit: 1, checkpoint: async () => {} })).rejects.toThrow("page budget");
    } finally { await client.close(); }
  });

  it("reads fresh ownership pages without Git discovery for unrelated workspaces", async () => {
    const enrich = vi.fn(async () => ({ linkedDirectories: [] }));
    const checkpoint = vi.fn(async () => {});
    const client = new CodexAppServerClient({ threadDirectoryEnricher: enrich });
    try {
      const directoryFilter = vi.fn(async () => false);
      await client.listArchiveCleanupThreadsPage({ archived: false, limit: 100, checkpoint, directoryFilter });
      await client.listArchiveCleanupThreadsPage({ archived: false, limit: 100, checkpoint, directoryFilter });
      expect(ArchiveCleanupTransport.latest.listings).toHaveLength(2);
      expect(enrich).not.toHaveBeenCalled();
      expect(checkpoint).not.toHaveBeenCalled();
      expect(directoryFilter).toHaveBeenCalled();
    } finally { await client.close(); }
  });

  it("measures discovery and authoritative admission for 1876 distinct workspaces", async () => {
    const enrich = vi.fn(async () => ({ linkedDirectories: [] }));
    const client = new CodexAppServerClient({ threadDirectoryEnricher: enrich });
    try {
      // Initialize the fixture transport before installing the large dataset.
      await client.listArchiveCleanupThreadsPage({ archived: false, limit: 25, checkpoint: async () => {} });
      const transport = ArchiveCleanupTransport.latest;
      transport.rows = {
        active: Array.from({ length: 399 }, (_, id) => ({ id: `active-${id}`, cwd: `/fixture/active-${id}` })),
        archived: Array.from({ length: 1477 }, (_, id) => ({ id: `archived-${id}`, cwd: `/fixture/archived-${id}` })),
      };
      const read = async (admission: boolean) => {
        enrich.mockClear();
        transport.listings.length = 0;
        const directoryObservations = new Map();
        const directoryFilter = admission ? archiveCleanupWorkspaceFilter("/fixture/archived-0") : undefined;
        let identities = 0;
        for (const archived of [false, true]) {
          let cursor: string | undefined;
          do {
            const page = await client.listArchiveCleanupThreadsPage({ archived, cursor, limit: admission ? 100 : 25,
              checkpoint: async () => {}, directoryObservations, directoryFilter });
            identities += page.threads.length;
            cursor = page.nextCursor;
          } while (cursor);
        }
        return { identities, providerPages: transport.listings.length, gitDiscoveries: enrich.mock.calls.length };
      };
      expect(await read(false)).toEqual(budgets["harold-discovery"]);
      expect(await read(true)).toEqual(budgets["harold-admission"]);
      // A second candidate still reads all membership afresh and never uses
      // the first admission's canonical directory observations.
      expect(await read(true)).toEqual(budgets["harold-admission"]);
    } finally { await client.close(); }
  });
});
