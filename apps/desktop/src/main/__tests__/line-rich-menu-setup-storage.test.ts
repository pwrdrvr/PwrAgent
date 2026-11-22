import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import {
  LineRichMenuSetup,
  type LineRichMenuApi,
  type LineRichMenuDefault,
} from "@pwragent/messaging-provider-line";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createLineRichMenuSetupStorage } from "../storage/line-rich-menu-setup-storage";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let tempDir: string;
const accountId = `U${"a".repeat(32)}`;
const profile = new AsyncLocalStorage<{ db: StateDb; stateDir: string }>();

vi.mock("../state/app-state", () => ({
  getAppStateMode: () => "active-profile",
  getAppStateDb: () => profile.getStore()?.db ?? stateDb,
}));
vi.mock("../profile", () => ({
  resolveActiveProfilePath: () => profile.getStore()?.stateDir ?? tempDir,
  resolvePwragentRoot: () => tempDir,
}));

describe("desktop LINE setup ownership", () => {
  beforeEach(() => {
    vi.stubEnv(SQLITE_WRITE_METRICS_ENV, "1");
    const fixture = createTempStateDb("line-menu-");
    tempDir = fixture.tempDir;
    stateDb = StateDb.open(fixture.dbPath);
  });

  afterEach(() => {
    stateDb.close();
    rmSync(tempDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it("serializes setup for the same LINE account while allowing other accounts", async () => {
    const store = createLineRichMenuSetupStorage();
    await store.withAccount(accountId, async () => {
      await expect(createLineRichMenuSetupStorage().withAccount(accountId, async () => {}))
        .rejects.toMatchObject({ code: "busy" });
      await expect(store.withAccount(`U${"b".repeat(32)}`, async () => {})).resolves.toBeUndefined();
    });
    await expect(store.withAccount(accountId, async () => {})).resolves.toBeUndefined();
  });

  it("allows only one profile to install across a paused LINE assignment", async () => {
    const profileA = path.join(tempDir, "profile-a");
    const profileB = path.join(tempDir, "profile-b");
    mkdirSync(profileA);
    mkdirSync(profileB);
    await fc.assert(fc.asyncProperty(fc.boolean(), async (firstIsA) => {
      const first = { db: StateDb.open(":memory:"), stateDir: firstIsA ? profileA : profileB };
      const second = { db: StateDb.open(":memory:"), stateDir: firstIsA ? profileB : profileA };
      const assigning = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const assignments: string[] = [];
      let current: LineRichMenuDefault = { kind: "empty" };
      let created = 0;
      const api: LineRichMenuApi = {
        async accountId() { return accountId; },
        async getDefault() { return current; },
        async list() { return []; },
        async create() { return `richmenu-${String(++created).padStart(32, "0")}`; },
        async upload() {},
        async setDefault(id) {
          if (profile.getStore() === first) {
            assigning.resolve();
            await release.promise;
          }
          assignments.push(id);
          current = { kind: "api", id };
        },
        async delete() {},
      };
      const setup = () => new LineRichMenuSetup(api, createLineRichMenuSetupStorage(), {
        revision: "v1", menu: {}, image: new Blob(),
      });
      const installing = profile.run(first, () => setup().install(accountId));
      try {
        try {
          await Promise.race([assigning.promise, installing]);
          await expect(profile.run(second, () => setup().install(accountId))).rejects.toMatchObject({ code: "busy" });
        } finally {
          release.resolve();
          await installing;
        }
        await expect(profile.run(second, () => setup().install(accountId))).rejects.toMatchObject({ code: "different-menu" });
        expect(assignments).toEqual([`richmenu-${"1".padStart(32, "0")}`]);
        expect(first.db.getMeta(`line_rich_menu:${accountId}`)).toBeDefined();
        expect(second.db.getMeta(`line_rich_menu:${accountId}`)).toBeUndefined();
      } finally {
        first.db.close();
        second.db.close();
      }
    }), { numRuns: 12 });
  });

  it("budgets the durable writes for install, update, and removal", async () => {
    let current: LineRichMenuDefault = { kind: "empty" };
    let created = 0;
    const api: LineRichMenuApi = {
      async accountId() { return accountId; },
      async getDefault() { return current; },
      async list() { return []; },
      async create() { return `richmenu-${String(++created).padStart(32, "0")}`; },
      async upload() {},
      async setDefault(id) { current = { kind: "api", id }; },
      async delete(id) {
        if (current.kind === "api" && current.id === id) current = { kind: "empty" };
      },
    };
    const setup = (revision: string) => new LineRichMenuSetup(api, createLineRichMenuSetupStorage(), {
      revision, menu: {}, image: new Blob(),
    });
    const { writes } = await measureSqliteWrites(async () => {
      await setup("v1").install(accountId);
      expect(await setup("v1").inspect()).toMatchObject({ kind: "installed", updateAvailable: false });
      await setup("v2").install(accountId);
      expect(await setup("v2").inspect()).toMatchObject({ kind: "installed", updateAvailable: false });
      await setup("v2").remove(accountId);
      expect(await setup("v2").inspect()).toMatchObject({ kind: "available", cleanupRequired: false });
    });
    expectSqliteWriteBudget({
      note: "One LINE rich-menu install, update, and removal",
      scenario: "line-rich-menu-lifecycle",
      writes,
    });

    stateDb.setMeta(`line_rich_menu:${accountId}`, JSON.stringify({
      staged: { name: "PwrAgent setup interrupted", revision: "v2" },
    }));
    const recovery = await measureSqliteWrites(() => setup("v2").remove(accountId));
    expectSqliteWriteBudget({
      note: "Recover an interrupted LINE rich-menu create that never reached LINE",
      scenario: "line-rich-menu-recover-absent-create",
      writes: recovery.writes,
    });
  });
});
