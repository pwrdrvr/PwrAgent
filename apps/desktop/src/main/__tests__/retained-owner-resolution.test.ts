import fs from "node:fs";
import path from "node:path";
import { expect, onTestFinished, it, vi } from "vitest";

import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { retainedOwnerFixture } from "./helpers/retained-owner-fixture";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

function native(id: string) {
  return { id, source: "codex" as const, title: id, titleSource: "explicit" as const, createdAt: 1, updatedAt: 2, linkedDirectories: [] };
}

function fixture() {
  const f = retainedOwnerFixture(false, []);
  const configPath = path.join(f.root, "config.toml");
  fs.writeFileSync(configPath, "");
  const config = new DesktopConfigStore({ configPath });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const active = new Set<string>();
  const list = vi.spyOn(client, "listThreads").mockImplementation(async params => params?.archived ? [] : [...active].map(native));
  vi.spyOn(client, "listNativeSubAgentThreads").mockResolvedValue([]);
  const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: f.overlay, configStore: config,
    retainedOwnerThreadStorage: f.retained, providerThreadSnapshotStore: null, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, discoverLocalAcpAgents: async () => [] });
  const resolve = (threadId: string) => registry.resolveThread({ backend: "codex", threadId });
  const accept = (threadId: string) => f.jobs.save({ version: 1, id: threadId, status: "completed", fingerprint: threadId, threadId });
  onTestFinished(async () => { await registry.close(); await client.close(); config.dispose(); f.close(); });
  return { active, list, registry, resolve, accept, jobs: f.jobs, retained: f.retained };
}

it.each([false, true])("uses the provider's refreshed inventory after a point observation (enriched %s)", async enrichDirectories => {
  const { active, registry, resolve } = fixture();
  active.add("native");
  expect((await resolve("native"))?.id).toBe("native");
  active.clear();
  await registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories });
  expect(Boolean(await resolve("native"))).toBe(active.has("native"));
});

it("shares ACP discovery across simultaneous backend-less misses", async () => {
  const { registry } = fixture();
  const inventory = vi.spyOn(registry["acpBackend"], "listInventorySessions");
  const ids = ["first", "second", "third", "fourth"];
  expect(await Promise.all(ids.map(threadId => registry.resolveThread({ threadId })))).toEqual(ids.map(() => undefined));
  expect(inventory).toHaveBeenCalledTimes(1);
});

it("shares the archive walk across different retained IDs and rechecks each after it settles", async () => {
  const { list, resolve, accept, jobs } = fixture();
  const ids = ["first", "second", "third", "fourth"];
  ids.forEach(accept);
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  list.mockImplementation(async params => {
    if (params?.archived) { started.resolve(); await release.promise; }
    return [];
  });
  const pending = Promise.all(ids.map(resolve));
  await started.promise;
  jobs.save({ version: 1, id: "second", status: "completed", fingerprint: "second", threadId: "replacement" });
  release.resolve();
  expect((await pending).map(row => row?.id)).toEqual(["first", undefined, "third", "fourth"]);
  expect(list.mock.calls.filter(([params]) => params?.archived)).toHaveLength(1);
});

it("joins an archive walk already in flight when a later point lookup reaches it", async () => {
  const { list, resolve, accept, retained } = fixture();
  accept("first");
  accept("second");
  const started = Promise.withResolvers<void>();
  const joining = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  list.mockImplementation(async params => {
    if (params?.archived) { started.resolve(); await release.promise; }
    return [];
  });
  const get = retained.get.bind(retained);
  vi.spyOn(retained, "get").mockImplementation((id, archived) => {
    if (id === "second") joining.resolve();
    return get(id, archived);
  });
  const first = resolve("first");
  await started.promise;
  const second = resolve("second");
  try { await joining.promise; } finally { release.resolve(); }
  expect((await Promise.all([first, second])).map(row => row?.id)).toEqual(["first", "second"]);
  expect(list.mock.calls.filter(([params]) => params?.archived)).toHaveLength(1);
});

it.each(["refresh", "expiry"])("serves a retained point result until its inventory changes (%s)", async boundary => {
  const { list, registry, resolve, accept, jobs } = fixture();
  accept("retained");
  const identity = { backend: "codex" as const, threadId: "retained" };
  const row = await resolve(identity.threadId);
  expect(row?.id).toBe(identity.threadId);
  expect(registry.getCachedThreadSummary(identity)).toEqual(row);
  list.mockClear();
  expect(await resolve(identity.threadId)).toEqual(row);
  expect(list).not.toHaveBeenCalled();
  jobs.save({ version: 1, id: "retained", status: "completed", fingerprint: "retained", threadId: "replacement" });
  if (boundary === "refresh") {
    expect((await registry.listThreads({ backend: "codex", enrichDirectories: false })).map(thread => thread.id)).toEqual(["replacement"]);
  } else {
    const expired = Date.now() + 10 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(expired);
    onTestFinished(() => clock.mockRestore());
  }
  expect(await resolve(identity.threadId)).toBeUndefined();
});

it("fences a point observation that finishes after a newer complete listing", async () => {
  const { active, list, registry, resolve } = fixture();
  const admitted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  active.add("native");
  list.mockImplementationOnce(async () => {
    const snapshot = [...active].map(native);
    admitted.resolve();
    await release.promise;
    return snapshot;
  });
  const older = resolve("native");
  await admitted.promise;
  active.clear();
  const refreshed = registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: true });
  const newer = refreshed.then(() => resolve("native"));
  try { await refreshed; } finally { release.resolve(); }
  expect(Boolean(await newer)).toBe(active.has("native"));
  await older;
  expect(Boolean(await resolve("native"))).toBe(active.has("native"));
});
