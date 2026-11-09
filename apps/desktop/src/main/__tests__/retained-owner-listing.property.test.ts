import fc from "fast-check";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { DesktopBackendRegistry } from "../app-server/backend-registry";
import { CodexAppServerClient } from "../codex-app-server/desktop-client";
import { DesktopConfigStore } from "../settings/config-store/desktop-config-store";
import { retainedOwnerFixture } from "./helpers/retained-owner-fixture";

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
  const registry = new DesktopBackendRegistry({ codexClient: client, overlayStore: f.overlay, configStore: config,
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
