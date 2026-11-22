import { rmSync } from "node:fs";
import {
  LineRichMenuSetup,
  type LineRichMenuApi,
  type LineRichMenuDefault,
} from "@pwragent/messaging-provider-line";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateDb } from "../state/state-db";
import { measureSqliteWrites, SQLITE_WRITE_METRICS_ENV } from "../state/sqlite-write-metrics";
import { createLineRichMenuSetupStorage } from "../storage/line-rich-menu-setup-storage";
import { expectSqliteWriteBudget } from "./fixtures/sqlite-write-budget";
import { createTempStateDb } from "./sqlite-test-utils";

let stateDb: StateDb;
let tempDir: string;
const accountId = `U${"a".repeat(32)}`;

vi.mock("../state/app-state", () => ({
  getAppStateMode: () => "active-profile",
  getAppStateDb: () => stateDb,
}));
vi.mock("../profile", () => ({ resolveActiveProfilePath: () => tempDir }));

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
      async clearDefault() { current = { kind: "empty" }; },
      async delete() {},
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
  });
});
