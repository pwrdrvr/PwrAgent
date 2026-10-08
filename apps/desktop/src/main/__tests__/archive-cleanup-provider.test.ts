import { describe, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "../codex-app-server/client";
import { ArchiveCleanupTransport } from "./fixtures/archive-cleanup-transport";

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
});
