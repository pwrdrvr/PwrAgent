import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppServerAvailableCommandSummary } from "@pwragent/shared";
import { AcpAvailableCommandsStore } from "../acp/acp-available-commands-store";
import { CURRENT_STATE_DB_USER_VERSION, StateDb } from "../state/state-db";

let stateDb: StateDb;
let tempDir: string;
let store: AcpAvailableCommandsStore;

const COMMANDS: AppServerAvailableCommandSummary[] = [
  {
    name: "compact",
    description: "Compact this thread's context.",
    backend: "acp:grok",
    scope: "session",
    source: "provider",
  },
];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "pwragent-acp-commands-"));
  stateDb = StateDb.open(path.join(tempDir, "state.db"));
  store = new AcpAvailableCommandsStore(stateDb);
});

afterEach(() => {
  stateDb.close();
  rmSync(tempDir, { recursive: true, force: true });
});

describe("AcpAvailableCommandsStore", () => {
  it("round-trips commands for an agent and repository", () => {
    store.upsert({
      backendId: "acp:grok",
      repositoryPath: "/repo",
      commands: COMMANDS,
      observedAt: 1234,
    });

    expect(store.get("acp:grok", "/repo")).toEqual({
      backendId: "acp:grok",
      repositoryPath: "/repo",
      commands: COMMANDS,
      observedAt: 1234,
    });
  });

  it("keeps one row per agent and repository, newest write winning", () => {
    store.upsert({
      backendId: "acp:grok",
      repositoryPath: "/repo",
      commands: COMMANDS,
      observedAt: 1000,
    });
    store.upsert({
      backendId: "acp:grok",
      repositoryPath: "/repo",
      commands: [],
      observedAt: 2000,
    });

    expect(store.get("acp:grok", "/repo")).toEqual({
      backendId: "acp:grok",
      repositoryPath: "/repo",
      commands: [],
      observedAt: 2000,
    });
  });

  it("adds its table to a profile database that predates it", () => {
    const dbPath = path.join(tempDir, "migrated.db");
    const seeded = StateDb.open(dbPath);
    seeded.raw.exec("DROP TABLE acp_available_commands");
    seeded.raw.pragma("user_version = 49");
    seeded.close();

    const migrated = StateDb.open(dbPath);
    try {
      expect(migrated.raw.pragma("user_version", { simple: true })).toBe(
        CURRENT_STATE_DB_USER_VERSION,
      );
      const migratedStore = new AcpAvailableCommandsStore(migrated);
      migratedStore.upsert({
        backendId: "acp:grok",
        repositoryPath: "/repo",
        commands: COMMANDS,
        observedAt: 1000,
      });
      expect(migratedStore.get("acp:grok", "/repo")?.commands).toEqual(COMMANDS);
    } finally {
      migrated.close();
    }
  });

  it("scopes rows by agent and by repository", () => {
    store.upsert({
      backendId: "acp:grok",
      repositoryPath: "/repo",
      commands: COMMANDS,
      observedAt: 1000,
    });

    expect(store.get("acp:kimi", "/repo")).toBeUndefined();
    expect(store.get("acp:grok", "/other-repo")).toBeUndefined();
  });
});
