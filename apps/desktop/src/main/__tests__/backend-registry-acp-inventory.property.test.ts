import { expect, it, vi } from "vitest";
import type { AcpSessionMetadata } from "@pwragent/owner-core/acp-storage";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { AcpSessionStore } from "../storage/acp-session-store";
import { ProviderThreadSnapshotStore } from "../storage/provider-thread-snapshot-store";
import {
  createAcpSessionStoreMock,
  createOverlayStoreMock,
  MockBackendClient,
} from "./helpers/backend-registry-fixture";
import { createTempStateDb, openInMemoryStateDb, removeTempStateDbDir } from "./sqlite-test-utils";

type ListingParams = NonNullable<Parameters<DesktopBackendRegistry["listThreads"]>[0]>;

const inventoryCases = [
  { name: "active inventory", params: { forceRefresh: true }, decodesPerRow: 1 },
  { name: "archived inventory", params: { forceRefresh: true, archived: true }, decodesPerRow: 1 },
  { name: "startup hydration", params: { callerReason: "navigation-snapshot" }, decodesPerRow: 2 },
] satisfies Array<{ name: string; params: ListingParams; decodesPerRow: number }>;

it.each(inventoryCases)("$name stays within its ACP payload decode budget", async ({ params, decodesPerRow }) => {
  const rowCount = 4_096;
  const { dbPath, tempDir } = createTempStateDb("acp-inventory-");
  const db = StateDb.open(dbPath);
  const discoverLocalAcpAgents = vi.fn(async () => []);
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({ threads: [] }),
    overlayStore: new SqliteOverlayStore(db),
    acpSessionStore: new AcpSessionStore(db),
    providerThreadSnapshotStore: new ProviderThreadSnapshotStore(db),
    discoverLocalAcpAgents,
  });
  try {
    const rows = Array.from({ length: rowCount }, (_, index) => {
      const variant = index % 8;
      const session: AcpSessionMetadata = {
        backendId: index % 2 === 0 ? "acp:zulu-uninstalled" : "acp:alpha-uninstalled",
        sessionId: `session-${index}`,
        title: `Fixture ${index}`,
        createdAt: 1,
        updatedAt: 2 + Math.floor(index / 16),
        executionMode: "default",
        status: "idle",
        hidden: variant === 2 || variant === 3,
        archivedAt: variant === 4 || variant === 5 ? 1 : undefined,
      };
      const payload = variant === 6 ? `{broken fixture ${index}`
        : JSON.stringify(variant === 7 ? { ...session, title: undefined } : session);
      return { session, payload, corrupt: variant >= 6 };
    });
    const insert = db.raw.prepare(`
      INSERT INTO acp_sessions (backend_id, session_id, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `);
    db.raw.transaction(() => {
      for (const { session, payload } of rows) {
        insert.run(session.backendId, session.sessionId, session.createdAt, session.updatedAt, payload);
      }
    })();

    const expected = rows
      .filter(({ session, corrupt }) =>
        !corrupt && !session.hidden && (session.archivedAt !== undefined) === (params.archived === true))
      .map(({ session }) => ({
        source: session.backendId, id: session.sessionId, title: session.title, updatedAt: session.updatedAt,
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt || left.source.localeCompare(right.source));
    const payloads = new Set(rows.map(({ payload }) => payload));
    const parse = vi.spyOn(JSON, "parse");
    let threads;
    let decodes;
    try {
      threads = await registry.listThreads(params);
      decodes = parse.mock.calls.filter(([value]) => payloads.has(value)).length;
    } finally {
      parse.mockRestore();
    }
    expect(threads.map(({ source, id, title, updatedAt }) => ({ source, id, title, updatedAt }))).toEqual(expected);
    expect(discoverLocalAcpAgents).not.toHaveBeenCalled();
    expect(decodes).toBe(rowCount * decodesPerRow);
  } finally {
    await registry.close();
    db.close();
    removeTempStateDbDir(tempDir);
  }
});

it("does not list a mismatched row from a backend with no visible membership", async () => {
  const db = openInMemoryStateDb();
  const sessions = new AcpSessionStore(db);
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({ threads: [] }),
    overlayStore: new SqliteOverlayStore(db),
    acpSessionStore: sessions,
  });
  try {
    const session: AcpSessionMetadata = {
      backendId: "acp:uninstalled",
      sessionId: "valid",
      title: "Valid",
      createdAt: 1,
      updatedAt: 2,
      executionMode: "default",
      status: "idle",
    };
    sessions.upsertSession(session);
    db.raw.prepare(`
      INSERT INTO acp_sessions (backend_id, session_id, created_at, updated_at, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run("acp:orphan", "mismatched", 1, 2, JSON.stringify({ ...session, sessionId: "mismatched" }));

    expect((await registry.listThreads()).map(thread => thread.id)).toEqual(["valid"]);
  } finally {
    await registry.close();
    db.close();
  }
});

it("uses full-session membership for a store double without the ID-only read", async () => {
  const session: AcpSessionMetadata = {
    backendId: "acp:uninstalled",
    sessionId: "legacy-store",
    title: "Legacy store",
    createdAt: 1,
    updatedAt: 2,
    executionMode: "default",
    status: "idle",
  };
  const registry = createDesktopBackendRegistry({
    codexClient: new MockBackendClient({ threads: [] }),
    overlayStore: createOverlayStoreMock(),
    acpSessionStore: { ...createAcpSessionStoreMock([session]), listAllSessions: () => [session] },
  });
  try {
    await expect(registry.listThreads()).resolves.toEqual([
      expect.objectContaining({ id: session.sessionId, source: session.backendId }),
    ]);
  } finally {
    await registry.close();
  }
});
