import { rmSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopBackendRegistry } from "../app-server/backend-registry";
import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { SqliteOverlayStore } from "../state/overlay-store-sqlite";
import { StateDb } from "../state/state-db";
import { createTempStateDb } from "./sqlite-test-utils";

let directory: string;
let db: StateDb;
let overlayStore: SqliteOverlayStore;
let registry: DesktopBackendRegistry;

beforeEach(() => {
  const fixture = createTempStateDb("pwragent-registry-context-");
  directory = fixture.tempDir;
  db = StateDb.open(fixture.dbPath);
  overlayStore = new SqliteOverlayStore(db);
  registry = createDesktopBackendRegistry({
    codexClient: {
      close: async () => {}, getInitializeResult: async () => ({ methods: [] }),
      listThreads: async () => [], onNotification: () => () => {}, onPendingRequest: () => () => {},
      readConfiguredMcpServerNames: async () => [], listModels: async () => [],
    } as never,
    overlayStore, isBootstrapMode: () => false, resolveTokenMiserEnabled: () => false,
  });
});

afterEach(async () => {
  await registry.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function storePorts(): Array<{ group: string; name: string; optional: boolean }> {
  return Object.entries(registry.context.stores).flatMap(([group, ports]) =>
    Object.keys(ports).map((name) => ({
      group,
      name,
      optional: typeof Object.getOwnPropertyDescriptor(ports, name)?.get === "function",
    })));
}

it("calls the overlay store's current method through every context store port", async () => {
  const ports = storePorts();
  expect(ports.length).toBeGreaterThan(0);
  const store = overlayStore as unknown as Record<string, unknown>;
  for (const { group, name } of ports) {
    // Replaced after the registry was built, as an adapter or a test may do.
    const replacement = vi.fn(async () => undefined);
    store[name] = replacement;
    const groupPorts = registry.context.stores[group as keyof typeof registry.context.stores] as Record<string, unknown>;
    const port = groupPorts[name] as (...args: unknown[]) => unknown;
    // `lines` satisfies the usage-attribution wrapper the registry puts around the store.
    const args = { fixture: name, lines: [] };
    await port(args);
    expect(replacement, `${group}.${name} reads the store's method when called`).toHaveBeenCalledWith(args);
    expect(replacement.mock.contexts[0], `${group}.${name} is called on the store, not detached`).toBeDefined();
  }
});

it("reports an optional store method as absent while the store lacks it", () => {
  const optional = storePorts().filter((port) => port.optional);
  expect(optional.map((port) => port.name)).toContain("getThreadMetadata");
  const store = overlayStore as unknown as Record<string, unknown>;
  for (const { group, name } of optional) {
    store[name] = undefined;
    const groupPorts = registry.context.stores[group as keyof typeof registry.context.stores] as Record<string, unknown>;
    expect(groupPorts[name], `${group}.${name}`).toBeUndefined();
  }
});
