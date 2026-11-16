import { createDesktopBackendRegistry } from "../../app-server/backend-registry-wiring";
import type { DesktopBackendRegistry } from "../../app-server/backend-registry";
import { SqliteOverlayStore } from "../../state/overlay-store-sqlite";
import type { StateDb } from "../../state/state-db";
import { openInMemoryStateDb } from "../sqlite-test-utils";

/**
 * A registry from the composition root over an in-memory SQLite store and a
 * Codex client that answers only startup reads, for facade and port tests.
 * The caller closes the database it pushes onto `databases`.
 */
export function registryWithInMemoryStore(databases: StateDb[]): DesktopBackendRegistry {
  const db = openInMemoryStateDb();
  databases.push(db);
  return createDesktopBackendRegistry({
    overlayStore: new SqliteOverlayStore(db),
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [], onNotification: () => () => {}, onPendingRequest: () => () => {},
      readConfiguredMcpServerNames: async () => [], listModels: async () => [],
    } as never,
    archiveCleanupCheckpointStore: null,
    isBootstrapMode: () => false,
    resolveTokenMiserEnabled: () => false,
  });
}
