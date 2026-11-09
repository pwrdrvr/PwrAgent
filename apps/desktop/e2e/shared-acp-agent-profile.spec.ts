import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AcpAgentStore } from "@pwragent/sqlite-storage/acp-agent-store";
import { StateDb } from "@pwragent/sqlite-storage/state-db";
import type { AcpInstalledAgentRecord, AcpRegistrySnapshot } from "../src/main/acp/acp-registry-types";
import type { DesktopApi } from "../src/renderer/src/lib/desktop-api";
import { expect, test } from "./fixtures/electron-test";
import { launchElectronApp } from "./fixtures/electron-app";
import { stateDbPathForHomeRoot } from "./fixtures/readme-state-seeding";

const specDir = path.dirname(fileURLToPath(import.meta.url));
const backend = "acp:gemini" as const;
const portable: AcpInstalledAgentRecord = {
  backendId: backend, registryId: "gemini", name: "Invented portable Gemini", version: "1.0.0",
  distributionKind: "local", distributionSource: "Invented local runtime", installStatus: "installed",
  authStatus: "not-required", verificationStatus: "not-applicable", allowlistRuleId: "invented-portable-policy",
  installedAt: 1_779_400_000_000, updatedAt: 1_779_400_000_001,
  launchDescriptor: { backendId: backend, registryId: "gemini", distributionKind: "local",
    command: "/invented/portable-runtime", args: ["invented-only"], env: { INVENTED_HOST_VALUE: "retained" } },
  update: { status: "available", checkedAt: 1_779_400_000_001, currentVersion: "1.0.0", latestVersion: "2.0.0" },
  updateCommand: "/invented/portable-runtime",
};

// refresh:false reads durable records only; this test never discovers or starts
// an operator CLI and never fetches a registry or installer.
test("desktop Settings consumes portable ACP registry and agent records and returns acknowledged updates to Node", async () => {
  const app = await launchElectronApp({
    fixturePath: path.join(specDir, "fixtures/smoke/replay.fixture.json"),
    preLaunchHook(homeRoot) {
      const db = StateDb.open(stateDbPathForHomeRoot(homeRoot));
      try {
        const store = new AcpAgentStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>(db);
        store.saveRegistrySnapshot({ fetchedAt: 1234, agents: [], raw: { inventedPolicy: { allowed: false } } });
        store.upsertInstalledAgent(portable);
      } finally { db.close(); }
    },
  });
  try {
    await app.window.getByRole("button", { name: /Replay smoke thread/i }).first().click();
    await expect(app.window.getByText("The replay harness is live.")).toBeVisible();
    const read = () => app.window.evaluate(async () => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.listAcpAgents!({ refresh: false });
    });
    const acknowledge = (latestVersion: string, action: "dismiss" | "snooze") => app.window.evaluate(async request => {
      const api = (window as unknown as { pwragent: DesktopApi }).pwragent;
      return await api.acknowledgeAcpAgentUpdate!(request);
    }, { backendId: backend, latestVersion, action });
    const first = await read();
    expect(first.fetchedAt).toBe(1234);
    expect(first.entries.find(entry => entry.backendId === backend)).toMatchObject({ update: portable.update });
    expect(await acknowledge("wrong-version", "dismiss")).toEqual({ applied: false });
    const snoozed = await acknowledge("2.0.0", "snooze");
    expect(snoozed.applied).toBe(true);
    expect(snoozed.update?.snoozedUntil).toBeGreaterThan(Date.now());
    const raw = new Database(stateDbPathForHomeRoot(app.homeRoot), { readonly: true });
    try {
      const persisted = JSON.parse(raw.prepare("SELECT payload FROM acp_installed_agents WHERE backend_id = ?")
        .pluck().get(backend) as string) as AcpInstalledAgentRecord;
      expect(persisted).toEqual({ ...portable, update: snoozed.update });
    } finally { raw.close(); }

    // The next host commits a replacement while Electron remains open. Settings
    // must observe it rather than overwriting it from a previous read.
    const db = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new AcpAgentStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>(db);
      store.saveRegistrySnapshot({ fetchedAt: 5678, agents: [], raw: { inventedPolicy: { allowed: false }, revision: 2 } });
      store.upsertInstalledAgent({ ...portable, updatedAt: portable.updatedAt + 1,
        update: { ...portable.update!, latestVersion: "3.0.0" } });
    } finally { db.close(); }
    const second = await read();
    expect(second.fetchedAt).toBe(5678);
    expect(second.entries.find(entry => entry.backendId === backend)?.update).toMatchObject({ latestVersion: "3.0.0" });
    expect(await acknowledge("2.0.0", "dismiss")).toEqual({ applied: false });
    const dismissed = await acknowledge("3.0.0", "dismiss");
    expect(dismissed.applied).toBe(true);
    expect(dismissed.update?.dismissedAt).toBeGreaterThan(0);
    expect(dismissed.update?.snoozedUntil).toBeUndefined();
    await app.closeApplication();
    const reopened = StateDb.open(stateDbPathForHomeRoot(app.homeRoot));
    try {
      const store = new AcpAgentStore<AcpRegistrySnapshot, AcpInstalledAgentRecord>(reopened);
      expect(store.getInstalledAgent(backend)).toEqual({ ...portable, updatedAt: portable.updatedAt + 1, update: dismissed.update });
      expect(store.readRegistrySnapshot()).toEqual({ fetchedAt: 5678, agents: [], raw: { inventedPolicy: { allowed: false }, revision: 2 } });
    } finally { reopened.close(); }
  } finally { await app.close(); }
});
