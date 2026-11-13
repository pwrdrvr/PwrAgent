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

function storePorts(): Array<{ group: string; name: string }> {
  return Object.entries(registry.context.stores).flatMap(([group, ports]) =>
    Object.keys(ports).map((name) => ({ group, name })));
}

function readPort(group: string, name: string): unknown {
  const groupPorts = registry.context.stores[group as keyof typeof registry.context.stores] as Record<string, unknown>;
  return groupPorts[name];
}

it("calls the overlay store's current method through every context store port", async () => {
  const ports = storePorts();
  expect(ports.length).toBeGreaterThan(0);
  const store = overlayStore as unknown as Record<string, unknown>;
  for (const { group, name } of ports) {
    // Replaced after the registry was built, as an adapter or a test may do.
    const replacement = vi.fn(async () => undefined);
    store[name] = replacement;
    const port = readPort(group, name) as (...args: unknown[]) => unknown;
    // `lines` satisfies the usage-attribution wrapper the registry puts around the store.
    const args = { fixture: name, lines: [] };
    await port(args);
    expect(replacement, `${group}.${name} reads the store's method when called`).toHaveBeenCalledWith(args);
    expect(replacement.mock.contexts[0], `${group}.${name} is called on the store, not detached`).toBeDefined();
  }
});

it("never lets a port swallow a store method that is absent", async () => {
  const store = overlayStore as unknown as Record<string, unknown>;
  let absentPorts = 0;
  for (const { group, name } of storePorts()) {
    store[name] = undefined;
    const port = readPort(group, name);
    if (port === undefined) {
      // An optional method: callers see it is missing and take their fallback.
      absentPorts += 1;
      continue;
    }
    // A required method: a call fails loudly instead of quietly doing nothing.
    const call = async () => await (port as (...args: unknown[]) => unknown)({ lines: [] });
    await expect(call(), `${group}.${name}`).rejects.toThrow(TypeError);
  }
  expect(absentPorts).toBeGreaterThan(0);
});
