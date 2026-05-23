import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AcpAgentStore } from "../acp/acp-agent-store";
import type {
  AcpInstalledAgentRecord,
  AcpRegistrySnapshot,
} from "../acp/acp-registry-types";
import { StateDb } from "../state/state-db";

let stateDb: StateDb;
let tempDir: string;
let store: AcpAgentStore;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-acp-store-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AcpAgentStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AcpAgentStore", () => {
  it("persists and reads the latest registry snapshot", () => {
    const snapshot: AcpRegistrySnapshot = {
      fetchedAt: 1234,
      raw: { agents: [] },
      agents: [],
    };

    store.saveRegistrySnapshot(snapshot);

    expect(store.readRegistrySnapshot()).toEqual(snapshot);
  });

  it("persists installed agent provenance records", () => {
    const record: AcpInstalledAgentRecord = {
      backendId: "acp:codex-acp",
      registryId: "codex-acp",
      name: "Codex CLI",
      version: "0.14.0",
      distributionKind: "npx",
      distributionSource: "@zed-industries/codex-acp@0.14.0",
      installStatus: "installed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "codex-rule",
      installedAt: 1000,
      updatedAt: 2000,
      runtimeCapabilities: {
        schemaVersion: 1,
        status: "discovered",
        discoveredAt: 1500,
        checkedAt: 1500,
        source: "session-new",
        modes: {
          currentModeId: "default",
          availableModes: [{ id: "default", label: "Default" }],
        },
      },
    };

    store.upsertInstalledAgent(record);

    expect(store.getInstalledAgent("acp:codex-acp")).toEqual(record);
    expect(store.listInstalledAgents()).toEqual([record]);
  });

  it("updates existing installed records by backend id", () => {
    const base: AcpInstalledAgentRecord = {
      backendId: "acp:codex-acp",
      registryId: "codex-acp",
      name: "Codex CLI",
      distributionKind: "npx",
      distributionSource: "@zed-industries/codex-acp@0.14.0",
      installStatus: "install-failed",
      authStatus: "not-required",
      verificationStatus: "not-applicable",
      allowlistRuleId: "codex-rule",
      installedAt: 1000,
      updatedAt: 1000,
      lastError: "missing npx",
    };

    store.upsertInstalledAgent(base);
    store.upsertInstalledAgent({
      ...base,
      installStatus: "installed",
      updatedAt: 2000,
      lastError: undefined,
    });

    expect(store.listInstalledAgents()).toHaveLength(1);
    const installed = store.getInstalledAgent("acp:codex-acp");
    expect(installed).toMatchObject({
      installStatus: "installed",
      updatedAt: 2000,
    });
    expect(installed).not.toHaveProperty("lastError");
  });
});
