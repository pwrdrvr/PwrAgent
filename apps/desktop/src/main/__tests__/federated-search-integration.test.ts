import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppServerThreadSummary } from "@pwragent/shared";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { DesktopMessagingBackendBridge } from "../messaging/desktop-backend-bridge";
import { StateDb } from "../state/state-db";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { AcpSessionStore } from "../acp/acp-session-store";
import { FederatedSearchService } from "../federation/federated-search-service";
import { FederationRpcEndpoint } from "../federation/federation-rpc";
import { FederationRouter } from "../federation/federation-router";
import {
  FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient,
  registerFederationBackendHandlers,
  type FederationBackendOperations,
} from "../federation/federation-backend-bridge";

const exactId = "019fd821-1450-7952-85ca-3bb8e5d150da";
function row(
  id: string,
  title: string,
  extra: Partial<AppServerThreadSummary> = {},
): AppServerThreadSummary {
  return {
    id,
    title,
    titleSource: "explicit",
    source: "codex",
    linkedDirectories: [],
    updatedAt: 100,
    ...extra,
  };
}

describe("generic search through the owner adapter, registry and real SQLite", () => {
  let root: string;
  let db: StateDb;
  let store: SqliteOverlayStore;
  let registry: DesktopBackendRegistry;
  let bridge: DesktopMessagingBackendBridge;
  let rows: AppServerThreadSummary[];
  let sessions: AcpSessionStore;
  const listThreads = vi.fn(async (request: { archived?: boolean; filter?: string } = {}) =>
    rows.filter((thread) => Boolean(thread.archivedAt) === Boolean(request.archived)
      && (!request.filter || thread.title.toLowerCase().includes(request.filter.toLowerCase()))));

  beforeEach(() => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    root = mkdtempSync(path.join(os.tmpdir(), "pwragent-search-integration-"));
    db = StateDb.open(path.join(root, "state.db"));
    store = new SqliteOverlayStore(db);
    sessions = new AcpSessionStore(db);
    rows = [];
    listThreads.mockClear();
    registry = new DesktopBackendRegistry({
      overlayStore: store as never,
      acpSessionStore: sessions,
      codexClient: {
        listThreads,
        close: async () => {},
        getInitializeResult: async () => ({ methods: ["thread/list"] }),
        onNotification: () => () => {},
        onPendingRequest: () => () => {},
      } as never,
    });
    bridge = new DesktopMessagingBackendBridge(registry);
  });
  afterEach(async () => {
    await registry.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("selects an archived exact ID before text filtering and top K", async () => {
    rows = [row(exactId, "Archived work", { archivedAt: 200 }), row("decoy", exactId)];
    expect(await bridge.searchFederatedThreads({ query: exactId, backend: "codex", includeArchived: true, limit: 1 }))
      .toMatchObject({ threads: [{ id: exactId }], totalCount: 1, truncated: false });
  });

  it("matches summary and project path independently of provider text filtering", async () => {
    rows = [
      row("summary", "Unrelated title", { summary: "needle" }),
      row("path", "Another title", { projectKey: "/repos/needle" }),
      row("miss", "Other"),
    ];
    expect(await bridge.searchFederatedThreads({ query: "needle", backend: "codex", limit: 10 }))
      .toMatchObject({ threads: [{ id: "summary" }, { id: "path" }], totalCount: 2 });
  });

  it("does not repair directories or write SQLite on first or repeated search", async () => {
    rows = [row("worktree", "Needle", {
      projectKey: "/repos/project/wt",
      linkedDirectories: [{
        id: "worktree:/repos/project/wt",
        kind: "worktree",
        label: "project",
        path: "/repos/project",
        worktreePath: "/repos/project/wt",
      }],
    })];
    const { writes } = await measureSqliteWrites(async () => {
      for (const query of ["needle", "", "Needle"]) {
        await bridge.searchFederatedThreads({ query, backend: "codex", includeArchived: true, limit: 1 });
      }
    });
    expect(writes.commits).toBe(0);
    expect(listThreads).toHaveBeenCalledTimes(2);
    expectSqliteWriteBudget({
      scenario: "federated-owner-search",
      note: "first and repeated generic owner searches, including archives",
      writes,
    });
  });

  it("propagates provider failures instead of reporting a successful empty search", async () => {
    listThreads.mockRejectedValueOnce(new Error("Provider unavailable"));
    await expect(bridge.searchFederatedThreads({ query: "needle", backend: "codex", limit: 1 }))
      .rejects.toThrow("Provider unavailable");
    rows = [row("recovered", "Needle")];
    expect(await bridge.searchFederatedThreads({ query: "needle", backend: "codex", limit: 1 }))
      .toMatchObject({ threads: [{ id: "recovered" }], totalCount: 1 });
  });

  it("refreshes the read-only candidate cache after its short reuse window", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      rows = [row("old", "Needle")];
      await bridge.searchFederatedThreads({ query: "needle", backend: "codex", limit: 1 });
      rows = [row("new", "Needle")];
      now.mockReturnValue(3_001);
      expect(await bridge.searchFederatedThreads({ query: "needle", backend: "codex", limit: 1 }))
        .toMatchObject({ threads: [{ id: "new" }], totalCount: 1 });
      expect(listThreads).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("does not start archived discovery after the active read exhausts the deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    listThreads.mockImplementationOnce(async () => { now.mockReturnValue(1_101); return []; });
    try {
      await expect(bridge.searchFederatedThreads({ query: "needle", backend: "codex", includeArchived: true, limit: 1 },
        { deadlineAt: 1_100 })).rejects.toThrow("deadline expired");
      expect(listThreads).toHaveBeenCalledTimes(1);
      expect(listThreads).toHaveBeenCalledWith(expect.objectContaining({ deadlineAt: 1_100 }), expect.anything());
    } finally {
      now.mockRestore();
    }
  });

  it("searches ACP worktree paths with zero writes and preserves archive filters", async () => {
    sessions.upsertSession({
      backendId: "acp:test",
      sessionId: "session_1234567890",
      title: "Unrelated",
      cwd: "/repos/.worktrees/needle",
      createdAt: 1,
      updatedAt: 2,
      executionMode: "default",
      status: "idle",
      archivedAt: 3,
    });
    const { writes } = await measureSqliteWrites(async () => {
      expect(await bridge.searchFederatedThreads({ query: "needle", backend: "acp:test", limit: 1 }))
        .toMatchObject({ totalCount: 0 });
      expect(await bridge.searchFederatedThreads({ query: "needle", backend: "acp:test", includeArchived: true, limit: 1 }))
        .toMatchObject({ threads: [{ id: "session_1234567890" }], totalCount: 1 });
    });
    expect(writes.commits).toBe(0);
  });

  it("bounds the actual RPC response after filtering a large owner inventory", async () => {
    rows = Array.from({ length: 1_200 }, (_, index) => row(`match-${index}`, "Needle", {
      projectKey: "project", updatedAt: index,
    }));
    rows.push(row("wrong-project", "Needle", { projectKey: "other", updatedAt: 10_000 }));
    const router = new FederationRouter({
      localInstanceId: "owner",
      methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    });
    const replies: unknown[] = [];
    const rpc = new FederationRpcEndpoint({
      localInstanceId: "viewer",
      remoteInstanceId: "owner",
      sendEnvelope: (envelope) => { void router.routeEnvelope({ sourcePeerId: "viewer", envelope }); },
    });
    router.registerConnection({
      peerId: "viewer",
      capabilities: ["federated_search"],
      sendEnvelope: (envelope) => {
        replies.push(envelope);
        rpc.receiveEnvelope(envelope);
      },
    });
    registerFederationBackendHandlers({
      router,
      backend: {
        searchFederatedThreads: bridge.searchFederatedThreads.bind(bridge),
      } as FederationBackendOperations,
    });
    const service = new FederatedSearchService({
      includeLocal: false,
      local: { listThreads: vi.fn() },
      peers: () => [{ instanceId: "owner", label: "Owner", backend: new FederationRemoteBackendClient(rpc) }],
    });
    const result = await service.search({
      query: "needle",
      backend: "codex",
      projectKeys: ["project"],
      updatedAfter: 100,
      updatedBefore: 1_000,
      limit: 1,
    });
    expect(result).toMatchObject({ results: [{ thread: { id: "match-1000" } }], totalCount: 901, truncated: true, failures: [] });
    expect(replies).toEqual([expect.objectContaining({ kind: "response", result: {
      threads: [expect.objectContaining({ id: "match-1000" })], totalCount: 901, truncated: true,
    } })]);
  });
});
