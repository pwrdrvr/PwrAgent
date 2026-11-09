import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { StdioJsonRpcTransport } from "@pwrdrvr/agent-transport";
import { CodexAppServerClient } from "@pwragent/owner-core/codex-app-server/client";
import { RuntimeLeaseManager } from "@pwragent/owner-core/runtime-lease-manager";
import { ProfileThreadOwnerAdmission } from "@pwragent/owner-core/thread-owner-admission";
import { AppRuntimeInstanceStore } from "@pwragent/sqlite-storage/app-runtime-instance-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import { openOutpostProfileRuntime } from "../../../../../packages/pwragent/src/federation-core";

// A real stdio peer with test-owned records. No replay client or Codex files.
const server = `
  const row = { id: "fixture", preview: "Protocol viewer", cwd: "/fixture", createdAt: 1, updatedAt: 2, turns: [] };
  require("node:readline").createInterface({ input: process.stdin }).on("line", line => {
    const { id, method } = JSON.parse(line);
    if (id === undefined) return;
    const result = method === "initialize" ? { userAgent: "fixture/0.164.0", codexHome: "/fixture", platformFamily: "unix", platformOs: "linux" }
      : method === "thread/list" ? { data: [row], nextCursor: null }
      : ["thread/read", "thread/start"].includes(method) ? { thread: row }
      : { data: [], nextCursor: null };
    process.stdout.write(JSON.stringify({ id, result }) + "\\n");
  });
`;

it("browses a real protocol peer while Outpost owns the profile, and admits mutations only after handover", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "codex-passive-profile-"));
  const db = StateDb.open(path.join(root, "state.db"), { profileName: "fixture" });
  const outpost = openOutpostProfileRuntime({ stateDirectory: root, profileName: "fixture", cwd: root });
  const manager = new RuntimeLeaseManager({
    instanceId: "viewer", processId: process.pid, startedAt: Date.now(), systemBootedAt: 0,
    profileName: "fixture", cwd: root, store: new AppRuntimeInstanceStore(db),
    runtimeIdentityIsAlive: () => true,
  });
  const owner = new ProfileThreadOwnerAdmission(manager);
  const methods: string[] = [];
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new CodexAppServerClient({
    assertOwnerAdmission: () => owner.assertOwnership(),
    connectionObserver: { onMessage: event => {
      if (event.direction === "outbound" && event.envelope.method) methods.push(event.envelope.method);
    } },
  }, {
    createTransport: () => new StdioJsonRpcTransport({ command: process.execPath, args: ["-e", server], logger: log }),
    clientInfo: { name: "fixture", title: "Fixture" }, logger: log, rpcLogger: log,
    listingDiagnostics: { trace: async (_stage, _fields, operation) => await operation(), link: () => {} },
    authState: { isBlocked: () => false, assertAvailable: () => {} },
    signInRequiredMessage: "fixture", buildShellEnvironment: env => env,
    enrichThreadDirectory: async () => ({ linkedDirectories: [] }),
    sampleAppServerProcessTree: async () => ({}),
  });
  try {
    expect(await client.listThreads({ enrichDirectories: false })).toEqual([expect.objectContaining({ id: "fixture", title: "Protocol viewer" })]);
    await client.readThread({ threadId: "fixture" });
    expect(methods).toEqual(expect.arrayContaining(["initialize", "initialized", "thread/list", "thread/read"]));
    const before = [...methods];
    await expect(client.startThread({ cwd: root })).rejects.toThrow(/another PwrAgent runtime/);
    expect(methods).toEqual(before);
    expect(manager.snapshot("federation").leaseHeld).toBe(false);
    outpost.close();
    await client.startThread({ cwd: root });
    expect(methods).toContain("thread/start");
    expect(manager.snapshot("federation").leaseHeld).toBe(true);
  } finally {
    await client.close();
    owner.close();
    outpost.close();
    db.close();
    rmSync(root, { force: true, recursive: true });
  }
});
