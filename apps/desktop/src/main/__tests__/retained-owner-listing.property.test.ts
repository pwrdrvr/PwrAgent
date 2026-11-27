import { createDesktopBackendRegistry } from "../app-server/backend-registry-wiring";
import fc from "fast-check";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { retainedOwnerFixture } from "./helpers/retained-owner-fixture";
import { additionalFederationBackendCapabilities, FEDERATION_BACKEND_METHOD_CAPABILITIES,
  FederationRemoteBackendClient, registerFederationBackendHandlers, type FederationBackendOperations } from "../federation/federation-backend-bridge";
import { FederationRouter } from "../federation/federation-router";
import { FederationRpcEndpoint } from "../federation/federation-rpc";

vi.mock("../log", () => ({ getMainLogger: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }));

async function checkListing(acceptedImport: boolean, oppositePresent: boolean, kinds: readonly string[]) {
  const f = retainedOwnerFixture(false);
  const configPath = path.join(f.root, "config.toml");
  writeFileSync(configPath, "");
  const config = new DesktopConfigStore({ configPath });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const native = { id: "imported", source: "codex" as const, title: "Listed owner", titleSource: "explicit" as const,
    createdAt: 1, updatedAt: 2, linkedDirectories: [] };
  const listed = [native];
  const missing: string[] = [];
  const accepted: string[] = acceptedImport ? ["imported"] : [];
  for (let i = 0; i < kinds.length; i++) {
    const kind = kinds[i]!;
    const id = `accepted-${i}`;
    accepted.push(id);
    await f.overlay.updateThreadMetadata({ backend: "codex", threadId: id }, {
      title: { text: kind === "filtered" ? "Excluded owner" : "Listed owner", source: "explicit" },
      ...(kind === "archived" ? { archivedAt: 1 } : {}),
    });
    if (kind === "listed") listed.push({ ...native, id });
    if (kind === "missing") missing.push(id);
  }
  for (const threadId of accepted) f.jobs.save({ version: 1, id: threadId, status: "completed", fingerprint: `input-${threadId}`,
    threadId, turnId: `turn-${threadId}`, createdAt: "2026-01-01T00:00:00Z" });
  const list = vi.spyOn(client, "listThreads").mockImplementation(async params => params?.archived
    ? (oppositePresent ? missing.map(id => ({ ...native, id, archivedAt: 1 })) : []) : listed);
  vi.spyOn(client, "listNativeSubAgentThreads").mockResolvedValue([]);
  const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: f.overlay, configStore: config,
    retainedOwnerThreadStorage: f.retained, providerThreadSnapshotStore: null, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, discoverLocalAcpAgents: async () => [] });
  try {
    const result = await registry.listThreads({ backend: "codex", forceRefresh: true, enrichDirectories: false,
      callerReason: "thread-id-lookup", limit: listed.length, maxPages: 1, skipArchivedMetadataRefresh: true,
      filter: kinds.includes("filtered") ? "Listed" : undefined });
    // The model needs opposite authority only when a new retained row
    // could enter this collection. Already supplied native rows settle imports.
    expect(list.mock.calls.map(([params]) => params?.archived === true)).toEqual(missing.length ? [false, true] : [false]);
    expect(list.mock.calls[0]![0]).toMatchObject({ limit: listed.length, maxPages: 1, skipArchivedMetadataRefresh: true });
    if (missing.length) expect(list.mock.calls[1]![0]).toMatchObject({ archived: true, requireComplete: true });
    expect(result.map(thread => thread.id).sort()).toEqual([
      ...listed.map(thread => thread.id), ...(!oppositePresent ? missing : []),
    ].sort());
    expect((await f.overlay.getThreadMetadata({ backend: "codex", threadId: "imported" }))?.nativeMembershipRetired).toBe(false);
    for (const threadId of accepted) expect(f.jobs.get(threadId)).toMatchObject({ status: "completed", fingerprint: `input-${threadId}`,
      threadId, turnId: `turn-${threadId}` });
  } finally { await registry.close(); await client.close(); config.dispose(); f.close(); }
}

it("confirms a supplied pending import without walking the archive", async () => {
  await checkListing(false, false, []);
});

it("keeps a supplied accepted owner bounded without walking the archive", async () => {
  await checkListing(true, false, []);
});

it("discovers opposite native membership only for eligible retained identities missing from the supplied list", async () => {
  await fc.assert(fc.asyncProperty(fc.boolean(), fc.boolean(),
    fc.array(fc.constantFrom("listed", "filtered", "archived", "missing"), { maxLength: 5 }),
    checkListing), { numRuns: 30, examples: [[true, false, []], [false, false, []], [true, true, ["missing"]],
      [true, false, ["filtered", "archived"]]] });
});

it("changes a retained Codex thread's monitor preference only while it belongs to the active provider inventory", async () => {
  const f = retainedOwnerFixture();
  const thread = { id: "imported", source: "codex" as const, title: "Fixture owner", titleSource: "explicit" as const,
    createdAt: 1, updatedAt: 2, linkedDirectories: [] };
  const identity = { backend: "codex", threadId: thread.id } as const;
  f.jobs.save({ version: 1, id: thread.id, status: "completed", fingerprint: "fixture",
    threadId: thread.id, turnId: "fixture-turn", createdAt: "2026-01-01T00:00:00Z" });
  const provider = new CodexAppServerClient({ directoryResolver: async () => [] });
  let archived = true;
  vi.spyOn(provider, "listThreads").mockImplementation(async (params) => Boolean(params?.archived) === archived ? [thread] : []);
  vi.spyOn(provider, "listNativeSubAgentThreads").mockResolvedValue([]);
  const registry = createDesktopBackendRegistry({ codexClient: provider, overlayStore: f.overlay,
    retainedOwnerThreadStorage: f.retained, providerThreadSnapshotStore: null, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, discoverLocalAcpAgents: async () => [] });
  const router = new FederationRouter({ localInstanceId: "owner", methodCapabilities: FEDERATION_BACKEND_METHOD_CAPABILITIES,
    additionalRequiredCapabilities: additionalFederationBackendCapabilities });
  const rpc = new FederationRpcEndpoint({ localInstanceId: "viewer", remoteInstanceId: "owner",
    sendEnvelope: (envelope) => { void router.routeEnvelope({ envelope, sourcePeerId: "viewer" }); } });
  router.registerConnection({ peerId: "viewer", capabilities: ["turn_control", "thread_job_monitor_control"],
    sendEnvelope: (envelope) => { rpc.receiveEnvelope(envelope); } });
  registerFederationBackendHandlers({ router, backend: {
    resolveThread: async () => ({ thread: await registry.resolveThread(identity) }),
    isCodexThreadActive: (threadId: string) => registry.isThreadActiveForService({ backend: "codex", threadId }),
    setThreadJobMonitorCreation: registry.setThreadJobMonitorCreation.bind(registry),
  } as unknown as FederationBackendOperations });
  const remote = new FederationRemoteBackendClient(rpc);
  try {
    expect(await registry.resolveThread(identity)).toMatchObject({ id: thread.id });
    expect(await registry.resolveThread(identity)).not.toHaveProperty("archivedAt");
    await expect(remote.setThreadJobMonitorCreation({ threadId: thread.id, enabled: false })).rejects.toThrow("no longer available");
    expect((await f.overlay.getThreadOverlayState(identity))?.jobMonitorCreationEnabled).toBeUndefined();
    archived = false;
    await remote.setThreadJobMonitorCreation({ threadId: thread.id, enabled: false });
    expect((await f.overlay.getThreadOverlayState(identity))?.jobMonitorCreationEnabled).toBe(false);
    archived = true;
    await expect(remote.setThreadJobMonitorCreation({ threadId: thread.id, enabled: true })).rejects.toThrow("no longer available");
    expect((await f.overlay.getThreadOverlayState(identity))?.jobMonitorCreationEnabled).toBe(false);
  } finally { await registry.close(); await provider.close(); f.close(); }
});

it("resolves an archived job and an unknown ID without projecting unrelated retained owners", async () => {
  const f = retainedOwnerFixture(false, ["imported", "unrelated"]);
  const configPath = path.join(f.root, "config.toml");
  writeFileSync(configPath, "");
  const config = new DesktopConfigStore({ configPath });
  config.recordProviderDiscovery("codex", { candidates: [], selectedCommand: "/fixture/codex", selectedVersion: "0.159.2" });
  const client = new CodexAppServerClient({ directoryResolver: async () => [] });
  const archived = { id: "accepted", source: "codex" as const, title: "Native archive", titleSource: "explicit" as const,
    createdAt: 1, updatedAt: 2, linkedDirectories: [] };
  const list = vi.spyOn(client, "listThreads").mockImplementation(async params => params?.archived ? [archived] : []);
  vi.spyOn(client, "listNativeSubAgentThreads").mockResolvedValue([]);
  f.jobs.save({ version: 1, id: "receipt", threadId: archived.id, status: "completed", fingerprint: "accepted" });
  const projectAll = vi.spyOn(f.retained, "list");
  const prepared = vi.spyOn(f.db.raw, "prepare");
  const registry = createDesktopBackendRegistry({ codexClient: client, overlayStore: f.overlay, configStore: config,
    retainedOwnerThreadStorage: f.retained, providerThreadSnapshotStore: null, messagingStore: null,
    threadTitleGenerationService: null, pdfToolMcpServer: null, discoverLocalAcpAgents: async () => [] });
  try {
    const resolve = (threadId: string) => registry.resolveThread({ backend: "codex", threadId });
    expect(await resolve("missing")).toBeUndefined();
    expect(list.mock.calls.some(([params]) => params?.archived)).toBe(false);
    expect(await resolve("accepted")).toMatchObject({ id: archived.id, title: archived.title });
    expect(await registry.resolveThread({ threadId: "imported" })).toMatchObject({ id: "imported" });
    expect(projectAll).not.toHaveBeenCalled();
    const jobReads = new Set(prepared.mock.calls.map(([sql]) => sql).filter(sql => sql.includes("FROM owner_jobs")));
    expect(jobReads.size).toBeGreaterThan(0);
    for (const sql of jobReads) {
      const plan = f.db.raw.prepare("EXPLAIN QUERY PLAN " + sql).all(archived.id);
      expect(plan).toEqual([expect.objectContaining({ detail: expect.stringMatching(/SEARCH owner_jobs USING (?:COVERING )?INDEX/) })]);
    }
  } finally { await registry.close(); await client.close(); config.dispose(); f.close(); }
});
